import prisma from '../config/database';
import messageEncryptionService from './messageEncryption.service';
import webSocketManager from './websocketManager.service';
import firebaseService from './firebase.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';
import xss from 'xss';
import { MessageType, NotificationType } from '@prisma/client';

interface CreateMessageData {
  conversationId: string;
  senderId: string;
  content: string;
  messageType: MessageType;
  parentMessageId?: string;
  attachments?: AttachmentData[];
}

interface AttachmentData {
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

interface MessageWithDetails {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  messageType: MessageType;
  createdAt: Date;
  readAt?: Date;
  sender: {
    id: string;
    firstName: string;
    lastName: string;
    role: string;
  };
  attachments?: AttachmentData[];
  threadCount?: number;
}

interface ConversationDetails {
  id: string;
  title?: string;
  status: string;
  conversationType: string;
  clientId: string;
  lawyerId: string;
  lastMessageAt?: Date;
  totalMessages: number;
  clientUnreadCount: number;
  lawyerUnreadCount: number;
  client: {
    id: string;
    firstName: string;
    lastName: string;
  };
  lawyer: {
    id: string;
    firstName: string;
    lastName: string;
  };
  lastMessage?: MessageWithDetails;
}

interface SendMessageResult {
  success: boolean;
  message?: MessageWithDetails;
  error?: string;
}

class MessagingService {

  /**
   * Create a new conversation between lawyer and client
   */
  async createConversation(data: {
    clientId: string;
    lawyerId: string;
    appointmentId?: string;
    title?: string;
    conversationType?: string;
  }): Promise<ConversationDetails | null> {
    try {
      const conversation = await prisma.conversation.create({
        data: {
          clientId: data.clientId,
          lawyerId: data.lawyerId,
          appointmentId: data.appointmentId,
          title: data.title || 'Legal Consultation',
          conversationType: data.conversationType || 'consultation'
        },
        include: {
          client: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          },
          lawyer: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          }
        }
      });

      // Generate encryption key for attorney-client privilege
      await messageEncryptionService.generateConversationKey(conversation.id);

      // Log conversation creation
      await this.logCommunicationEvent('conversation_created', {
        conversationId: conversation.id,
        participants: [data.clientId, data.lawyerId],
        appointmentId: data.appointmentId
      }, data.clientId, conversation.id);

      console.log(`Created conversation ${conversation.id} between client ${data.clientId} and lawyer ${data.lawyerId}`);

      return {
        id: conversation.id,
        title: conversation.title || undefined,
        status: conversation.status,
        conversationType: conversation.conversationType,
        clientId: conversation.clientId,
        lawyerId: conversation.lawyerId,
        lastMessageAt: conversation.lastMessageAt || undefined,
        totalMessages: conversation.totalMessages,
        clientUnreadCount: conversation.clientUnreadCount,
        lawyerUnreadCount: conversation.lawyerUnreadCount,
        client: conversation.client,
        lawyer: conversation.lawyer
      };

    } catch (error) {
      console.error('Failed to create conversation:', error);
      return null;
    }
  }

  /**
   * Send a new message in a conversation
   */
  async sendMessage(data: CreateMessageData): Promise<SendMessageResult> {
    try {
      // Validate conversation access
      const conversation = await prisma.conversation.findUnique({
        where: { id: data.conversationId },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, role: true } },
          lawyer: { select: { id: true, firstName: true, lastName: true, role: true } }
        }
      });

      if (!conversation) {
        return { success: false, error: 'Conversation not found' };
      }

      // Check if sender is a participant
      if (data.senderId !== conversation.clientId && data.senderId !== conversation.lawyer.id) {
        return { success: false, error: 'Access denied' };
      }

      const sanitizedContent = data.content ? xss(data.content) : '';

      if (!sanitizedContent.trim() && data.messageType === MessageType.TEXT) {
        return { success: false, error: 'Message content cannot be empty' };
      }

      const attachmentMetadata = data.attachments?.map((attachment) => ({
        url: attachment.url,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        mimeType: attachment.mimeType
      }));

      // Encrypt message content if required
      let storedContent = sanitizedContent;
      let encryptionKeyId: string | null = null;
      const shouldEncrypt = await messageEncryptionService.shouldEncryptConversation(data.conversationId);

      if (shouldEncrypt && sanitizedContent) {
        const encryptionResult = await messageEncryptionService.encryptMessage(sanitizedContent, data.conversationId);
        storedContent = encryptionResult.encryptedContent;
        encryptionKeyId = encryptionResult.encryptionKeyId;
      }

      // Create message
      const message = await prisma.message.create({
        data: {
          conversationId: data.conversationId,
          senderId: data.senderId,
          content: storedContent,
          originalContent: shouldEncrypt ? undefined : sanitizedContent,
          messageType: data.messageType,
          parentMessageId: data.parentMessageId,
          isEncrypted: shouldEncrypt,
          encryptionKeyId,
          attachmentUrl: data.attachments?.[0]?.url,
          attachmentFileName: data.attachments?.[0]?.fileName,
          attachmentFileSize: data.attachments?.[0]?.fileSize,
          attachmentMimeType: data.attachments?.[0]?.mimeType,
          systemMessageData: attachmentMetadata?.length ? { attachments: attachmentMetadata } : undefined
        },
        include: {
          sender: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true
            }
          }
        }
      });

      // Update conversation counters and last message time
      const recipientId = data.senderId === conversation.clientId ? conversation.lawyer.id : conversation.clientId;
      const isClientSender = data.senderId === conversation.clientId;

      await prisma.conversation.update({
        where: { id: data.conversationId },
        data: {
          lastMessageAt: new Date(),
          lastActivityAt: new Date(),
          totalMessages: { increment: 1 },
          clientUnreadCount: isClientSender ? undefined : { increment: 1 },
          lawyerUnreadCount: isClientSender ? { increment: 1 } : undefined
        }
      });

      // Update thread count if this is a reply
      if (data.parentMessageId) {
        await prisma.message.update({
          where: { id: data.parentMessageId },
          data: { threadCount: { increment: 1 } }
        });
      }

      // Prepare message for real-time delivery
      const messageForDelivery: MessageWithDetails = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        content: shouldEncrypt ? sanitizedContent : message.content!,
        messageType: message.messageType,
        createdAt: message.createdAt,
        sender: message.sender,
        attachments: data.attachments
      };

      try {
        await webSocketManager.emitToConversation(
          data.conversationId,
          'message:new',
          {
            ...messageForDelivery,
            createdAt: message.createdAt.toISOString(),
            sender: {
              ...message.sender,
              fullName: `${message.sender.firstName} ${message.sender.lastName}`
            }
          },
          { excludeUserId: data.senderId }
        );

        await webSocketManager.emitToUser(data.senderId, 'message:ack', {
          conversationId: data.conversationId,
          messageId: message.id,
          deliveredAt: new Date().toISOString()
        });

  loggingService.log(LogLevel.DEBUG, LogCategory.USER_ACTION, 'Realtime message delivered', {
          conversationId: data.conversationId,
          messageId: message.id,
          senderId: data.senderId
        });
      } catch (socketError) {
        loggingService.logError(socketError as Error, undefined, {
          operation: 'websocket_message_delivery',
          conversationId: data.conversationId,
          messageId: message.id
        });
      }

      // Send push notification to offline recipient
      const isRecipientOnline = webSocketManager.isUserConnected(recipientId);
      if (!isRecipientOnline) {
        const senderName = `${message.sender.firstName} ${message.sender.lastName}`;
        await firebaseService.sendMessageNotification(
          recipientId,
          senderName,
          sanitizedContent,
          data.conversationId
        );

        await webSocketManager.notifyOfflineParticipants(
          data.conversationId,
          data.senderId,
          {
            title: 'New secure message',
            message: `${senderName}: ${sanitizedContent.substring(0, 140)}${sanitizedContent.length > 140 ? '…' : ''}`,
            type: NotificationType.NEW_MESSAGE,
            metadata: {
              messageId: message.id,
              conversationId: data.conversationId
            }
          }
        );
      }

      // Log message for audit
      await this.logCommunicationEvent('message_sent', {
        messageId: message.id,
        conversationId: data.conversationId,
        messageType: data.messageType,
        hasAttachment: !!data.attachments?.length,
        isEncrypted: shouldEncrypt
      }, data.senderId, data.conversationId);

      console.log(`Message sent in conversation ${data.conversationId} by ${data.senderId}`);

      return {
        success: true,
        message: messageForDelivery
      };

    } catch (error) {
      console.error('Failed to send message:', error);
      return { success: false, error: 'Failed to send message' };
    }
  }

  /**
   * Mark message as read
   */
  async markMessageAsRead(messageId: string, userId: string): Promise<boolean> {
    try {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: {
          conversation: {
            select: {
              id: true,
              clientId: true,
              lawyerId: true
            }
          }
        }
      });

      if (!message) {
        return false;
      }

      // Check if user is a participant and not the sender
      const conversation = message.conversation;
      if (message.senderId === userId) {
        return true; // Sender doesn't need to mark own message as read
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return false; // Access denied
      }

      // Update message read status
      await prisma.message.update({
        where: { id: messageId },
        data: {
          readAt: new Date(),
          readById: userId
        }
      });

      // Update conversation unread count
      const isClient = userId === conversation.clientId;
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          clientUnreadCount: isClient ? { decrement: 1 } : undefined,
          lawyerUnreadCount: isClient ? undefined : { decrement: 1 }
        }
      });

      await webSocketManager.emitToConversation(
        conversation.id,
        'message:read',
        {
          messageId,
          readBy: userId,
          readAt: new Date().toISOString()
        },
        { excludeUserId: userId }
      );

      return true;

    } catch (error) {
      console.error('Failed to mark message as read:', error);
      return false;
    }
  }

  async sendTypingIndicator(conversationId: string, userId: string, isTyping: boolean): Promise<boolean> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) {
        return false;
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return false;
      }

      await webSocketManager.emitToConversation(
        conversationId,
        'typing',
        {
          conversationId,
          userId,
          isTyping,
          timestamp: new Date().toISOString()
        },
        { excludeUserId: userId }
      );

      return true;
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'messaging_typing_indicator',
        conversationId,
        userId
      });

      return false;
    }
  }

  /**
   * Get user's conversations
   */
  async getUserConversations(
    userId: string,
    options: {
      status?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<ConversationDetails[]> {
    try {
      const { status = 'active', limit = 20, offset = 0 } = options;

      const conversations = await prisma.conversation.findMany({
        where: {
          OR: [
            { clientId: userId },
            { lawyerId: userId }
          ],
          status
        },
        include: {
          client: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          },
          lawyer: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          },
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: {
              sender: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  role: true
                }
              }
            }
          }
        },
        orderBy: { lastActivityAt: 'desc' },
        take: limit,
        skip: offset
      });

      // Decrypt last messages if encrypted
      const conversationsWithDecrypted = await Promise.all(
        conversations.map(async (conv) => {
          let lastMessage;
          if (conv.messages.length > 0) {
            const msg = conv.messages[0];
            let content = msg.content;

            // Decrypt if encrypted
            if (msg.isEncrypted && msg.encryptionKeyId && msg.content) {
              const decryption = await messageEncryptionService.decryptMessage(
                msg.content,
                msg.encryptionKeyId
              );
              content = decryption.content;
            }

            lastMessage = {
              id: msg.id,
              conversationId: msg.conversationId,
              senderId: msg.senderId,
              content: content || '',
              messageType: msg.messageType,
              createdAt: msg.createdAt,
              readAt: msg.readAt || undefined,
              sender: msg.sender,
              attachments: undefined,
              threadCount: 0
            };
          }

          return {
            id: conv.id,
            title: conv.title || undefined,
            status: conv.status,
            conversationType: conv.conversationType,
            clientId: conv.clientId,
            lawyerId: conv.lawyerId,
            lastMessageAt: conv.lastMessageAt || undefined,
            totalMessages: conv.totalMessages,
            clientUnreadCount: conv.clientUnreadCount,
            lawyerUnreadCount: conv.lawyerUnreadCount,
            client: conv.client,
            lawyer: conv.lawyer,
            lastMessage
          };
        })
      );

      return conversationsWithDecrypted;

    } catch (error) {
      console.error('Failed to get user conversations:', error);
      return [];
    }
  }

  /**
   * Get messages for a conversation
   */
  async getConversationMessages(
    conversationId: string,
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      before?: Date;
    } = {}
  ): Promise<MessageWithDetails[]> {
    try {
      const { limit = 50, offset = 0, before } = options;

      // Validate access
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) {
        return [];
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return []; // Access denied
      }

      // Get messages
      const messages = await prisma.message.findMany({
        where: {
          conversationId,
          createdAt: before ? { lt: before } : undefined
        },
        include: {
          sender: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      });

      // Decrypt messages
      const decryptedMessages = await Promise.all(
        messages.map(async (msg) => {
          let content = msg.content;

          if (msg.isEncrypted && msg.encryptionKeyId && msg.content) {
            const decryption = await messageEncryptionService.decryptMessage(
              msg.content,
              msg.encryptionKeyId
            );
            content = decryption.content;
          }

          const attachments: AttachmentData[] = [];
          if (msg.attachmentUrl) {
            attachments.push({
              url: msg.attachmentUrl,
              fileName: msg.attachmentFileName || 'file',
              fileSize: msg.attachmentFileSize || 0,
              mimeType: msg.attachmentMimeType || 'application/octet-stream'
            });
          }

          return {
            id: msg.id,
            conversationId: msg.conversationId,
            senderId: msg.senderId,
            content: content || '',
            messageType: msg.messageType,
            createdAt: msg.createdAt,
            readAt: msg.readAt || undefined,
            sender: msg.sender,
            attachments: attachments.length > 0 ? attachments : undefined,
            threadCount: msg.threadCount
          };
        })
      );

      return decryptedMessages.reverse(); // Return in chronological order

    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return [];
    }
  }

  /**
   * Send system message (for events like appointment created, etc.)
   */
  async sendSystemMessage(
    conversationId: string,
    messageType: string,
    data: any,
    content?: string
  ): Promise<boolean> {
    try {
      await prisma.message.create({
        data: {
          conversationId,
          senderId: 'system',
          content: content || null,
          originalContent: content || null,
          messageType: 'TEXT',
          systemMessageType: messageType,
          systemMessageData: data,
          isEncrypted: false
        }
      });

      // Update conversation
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastActivityAt: new Date(),
          totalMessages: { increment: 1 }
        }
      });

            // Broadcast to conversation participants
      // TODO: Fix WebSocket service method calls
      // await webSocketManager.sendMessage(
      //   conversationId,
      //   'system_message',
      //   {
      //     conversationId,
      //     messageType,
      //     content,
      //     timestamp: new Date()
      //   }
      // );

      return true;

    } catch (error) {
      console.error('Failed to send system message:', error);
      return false;
    }
  }

  /**
   * Archive a conversation
   */
  async archiveConversation(conversationId: string, userId: string): Promise<boolean> {
    try {
      // Validate access
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) {
        return false;
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return false;
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'archived' }
      });

      // Log action
      await this.logCommunicationEvent('conversation_archived', {
        conversationId
      }, userId, conversationId);

      return true;

    } catch (error) {
      console.error('Failed to archive conversation:', error);
      return false;
    }
  }

  /**
   * Delete a message (soft delete)
   */
  async deleteMessage(messageId: string, userId: string): Promise<boolean> {
    try {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: { conversation: true }
      });

      if (!message) {
        return false;
      }

      // Only sender or conversation participants can delete
      if (message.senderId !== userId &&
          message.conversation.clientId !== userId &&
          message.conversation.lawyerId !== userId) {
        return false;
      }

      await prisma.message.update({
        where: { id: messageId },
        data: {
          // isActive: true, // Field doesn't exist in schema
          // deletedAt: new Date(), // Field doesn't exist in schema
          // deletedBy: userId, // Field doesn't exist in schema
          content: '[DELETED MESSAGE]'
        }
      });

      // Notify conversation participants
      // TODO: Fix WebSocket service method calls
      // await webSocketManager.sendMessage(
      //   message.conversationId,
      //   'message_deleted',
      //   {
      //     messageId,
      //     deletedBy: userId,
      //     deletedAt: new Date()
      //   }
      // );

      return true;

    } catch (error) {
      console.error('Failed to delete message:', error);
      return false;
    }
  }

  /**
   * Log communication event for audit
   */
  private async logCommunicationEvent(
    eventType: string,
    eventData: any,
    initiatedBy: string,
    conversationId?: string,
    targetUserId?: string
  ): Promise<void> {
    try {
      // Check if this involves attorney-client communication
      let isPrivileged = false;
      if (conversationId) {
        isPrivileged = await messageEncryptionService.shouldEncryptConversation(conversationId);
      }

      await prisma.communicationAuditLog.create({
        data: {
          eventType,
          eventData,
          initiatedBy,
          targetUserId,
          conversationId,
          isPrivileged
        }
      });

    } catch (error) {
      console.error('Failed to log communication event:', error);
    }
  }

  /**
   * Get conversation statistics
   */
  async getConversationStats(conversationId: string, userId: string): Promise<any> {
    try {
      // Validate access
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) {
        return null;
      }

      if (userId !== conversation.clientId && userId !== conversation.lawyerId) {
        return null;
      }

      // Get message statistics
      const stats = await prisma.message.aggregate({
        where: { conversationId },
        _count: { id: true }
      });

      const messagesByType = await prisma.message.groupBy({
        by: ['messageType'],
        where: { conversationId },
        _count: { id: true }
      });

      return {
        totalMessages: stats._count.id,
        messagesByType: messagesByType.reduce((acc, item) => {
          acc[item.messageType] = item._count.id;
          return acc;
        }, {} as Record<string, number>)
      };

    } catch (error) {
      console.error('Failed to get conversation stats:', error);
      return null;
    }
  }
}

// Create singleton instance
const messagingService = new MessagingService();

export default messagingService;
export { CreateMessageData, MessageWithDetails, ConversationDetails, SendMessageResult };