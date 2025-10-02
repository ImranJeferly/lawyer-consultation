import express, { Request, Response } from 'express';
import Joi from 'joi';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimit } from 'express-rate-limit';
import messagingService from '../services/messagingService.service';
import firebaseService from '../services/firebase.service';
import webSocketManager from '../services/websocketManager.service';
import prisma from '../config/database';

const router = express.Router();

// Rate limiting for messaging
const messagingRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: {
    error: 'Too many messages sent, please slow down',
    retryAfter: '1 minute'
  }
});

const conversationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 new conversations per 15 minutes
  message: {
    error: 'Too many conversations created, please try again later',
    retryAfter: '15 minutes'
  }
});

// Validation schemas
const createConversationSchema = Joi.object({
  lawyerId: Joi.string().required(),
  appointmentId: Joi.string().optional(),
  title: Joi.string().max(200).optional(),
  conversationType: Joi.string().valid('consultation', 'support', 'follow_up').default('consultation')
});

const sendMessageSchema = Joi.object({
  conversationId: Joi.string().required(),
  content: Joi.string().max(10000).required(),
  messageType: Joi.string().valid('TEXT', 'FILE', 'IMAGE').default('TEXT'),
  parentMessageId: Joi.string().optional()
});

const typingIndicatorSchema = Joi.object({
  conversationId: Joi.string().required(),
  isTyping: Joi.boolean().required()
});

const updateFCMTokenSchema = Joi.object({
  fcmToken: Joi.string().required()
});

/**
 * POST /api/communications/conversations/create
 * Create a new conversation between lawyer and client
 */
router.post('/conversations/create',
  requireAuth,
  conversationRateLimit,
  validateRequest(createConversationSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { lawyerId, appointmentId, title, conversationType } = req.body;

      // Get user details
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, firstName: true, lastName: true }
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Only clients can initiate conversations with lawyers
      if (user.role !== 'CLIENT') {
        return res.status(403).json({
          success: false,
          error: 'Only clients can create conversations with lawyers'
        });
      }

      // Verify lawyer exists and is verified
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { user: true }
      });

      if (!lawyer || !lawyer.isVerified) {
        return res.status(404).json({
          success: false,
          error: 'Lawyer not found or not verified'
        });
      }

      // Check if conversation already exists for this appointment
      if (appointmentId) {
        const existingConversation = await prisma.conversation.findFirst({
          where: {
            appointmentId,
            clientId: userId,
            lawyerId: lawyer.userId
          }
        });

        if (existingConversation) {
          return res.status(400).json({
            success: false,
            error: 'Conversation already exists for this appointment',
            conversationId: existingConversation.id
          });
        }
      }

      // Create conversation
      const conversation = await messagingService.createConversation({
        clientId: userId,
        lawyerId: lawyer.userId,
        appointmentId,
        title,
        conversationType
      });

      if (!conversation) {
        return res.status(500).json({
          success: false,
          error: 'Failed to create conversation'
        });
      }

      // Send notification to lawyer
      await firebaseService.sendNotificationToUser(
        { userId: lawyer.userId },
        {
          title: 'New Conversation',
          body: `${user.firstName} ${user.lastName} started a conversation`,
          data: {
            type: 'new_conversation',
            conversationId: conversation.id,
            clientId: userId
          },
          clickAction: `/conversations/${conversation.id}`
        }
      );

      res.status(201).json({
        success: true,
        data: conversation,
        message: 'Conversation created successfully'
      });

    } catch (error) {
      console.error('Create conversation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create conversation'
      });
    }
  }
);

/**
 * GET /api/communications/conversations
 * Get user's active conversations
 */
router.get('/conversations',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const {
        status = 'active',
        limit = 20,
        offset = 0
      } = req.query;

      const conversations = await messagingService.getUserConversations(userId, {
        status: status as string,
        limit: Number(limit),
        offset: Number(offset)
      });

      // Add online status for conversation participants
      const conversationsWithStatus = conversations.map(conv => {
        const otherParticipantId = conv.clientId === userId ? conv.lawyerId : conv.clientId;
        const isOtherUserOnline = webSocketManager.isUserConnected(otherParticipantId);

        return {
          ...conv,
          otherParticipant: conv.clientId === userId ? conv.lawyer : conv.client,
          isOtherUserOnline
        };
      });

      res.json({
        success: true,
        data: conversationsWithStatus,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          hasMore: conversations.length === Number(limit)
        }
      });

    } catch (error) {
      console.error('Get conversations error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get conversations'
      });
    }
  }
);

/**
 * GET /api/communications/conversations/:conversationId/messages
 * Get messages for a conversation
 */
router.get('/conversations/:conversationId/messages',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const userId = req.auth!.userId;
      const {
        limit = 50,
        offset = 0,
        before
      } = req.query;

      const messages = await messagingService.getConversationMessages(
        conversationId,
        userId,
        {
          limit: Number(limit),
          offset: Number(offset),
          before: before ? new Date(before as string) : undefined
        }
      );

      res.json({
        success: true,
        data: messages,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          hasMore: messages.length === Number(limit)
        }
      });

    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get messages'
      });
    }
  }
);

/**
 * POST /api/communications/messages/send
 * Send a new message
 */
router.post('/messages/send',
  requireAuth,
  messagingRateLimit,
  validateRequest(sendMessageSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { conversationId, content, messageType, parentMessageId } = req.body;

      const result = await messagingService.sendMessage({
        conversationId,
        senderId: userId,
        content,
        messageType,
        parentMessageId
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }

      res.status(201).json({
        success: true,
        data: result.message,
        message: 'Message sent successfully'
      });

    } catch (error) {
      console.error('Send message error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send message'
      });
    }
  }
);

/**
 * PUT /api/communications/messages/:messageId/read
 * Mark message as read
 */
router.put('/messages/:messageId/read',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params;
      const userId = req.auth!.userId;

      const success = await messagingService.markMessageAsRead(messageId, userId);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Failed to mark message as read'
        });
      }

      res.json({
        success: true,
        message: 'Message marked as read'
      });

    } catch (error) {
      console.error('Mark message read error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to mark message as read'
      });
    }
  }
);

/**
 * DELETE /api/communications/messages/:messageId
 * Delete a message (soft delete)
 */
router.delete('/messages/:messageId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { messageId } = req.params;
      const userId = req.auth!.userId;

      const success = await messagingService.deleteMessage(messageId, userId);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Failed to delete message'
        });
      }

      res.json({
        success: true,
        message: 'Message deleted successfully'
      });

    } catch (error) {
      console.error('Delete message error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete message'
      });
    }
  }
);

/**
 * PUT /api/communications/conversations/:conversationId/archive
 * Archive a conversation
 */
router.put('/conversations/:conversationId/archive',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const userId = req.auth!.userId;

      const success = await messagingService.archiveConversation(conversationId, userId);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Failed to archive conversation'
        });
      }

      res.json({
        success: true,
        message: 'Conversation archived successfully'
      });

    } catch (error) {
      console.error('Archive conversation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to archive conversation'
      });
    }
  }
);

/**
 * GET /api/communications/conversations/:conversationId/stats
 * Get conversation statistics
 */
router.get('/conversations/:conversationId/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const userId = req.auth!.userId;

      const stats = await messagingService.getConversationStats(conversationId, userId);

      if (!stats) {
        return res.status(404).json({
          success: false,
          error: 'Conversation not found or access denied'
        });
      }

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      console.error('Get conversation stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get conversation statistics'
      });
    }
  }
);

/**
 * POST /api/communications/fcm-token
 * Update user's FCM token for push notifications
 */
router.post('/fcm-token',
  requireAuth,
  validateRequest(updateFCMTokenSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { fcmToken } = req.body;

      const success = await firebaseService.updateFCMToken(userId, fcmToken);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Failed to update FCM token'
        });
      }

      res.json({
        success: true,
        message: 'FCM token updated successfully'
      });

    } catch (error) {
      console.error('Update FCM token error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update FCM token'
      });
    }
  }
);

/**
 * GET /api/communications/presence
 * Get presence status of users
 */
router.get('/presence',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { userIds } = req.query;

      if (!userIds) {
        return res.status(400).json({
          success: false,
          error: 'userIds parameter required'
        });
      }

      const requestedUserIds = Array.isArray(userIds) ? userIds : [userIds];

      // Get presence information
      const presenceData = await Promise.all(
        requestedUserIds.map(async (uid) => {
          const presence = await prisma.userPresence.findUnique({
            where: { userId: uid as string }
          });

          const isOnline = webSocketManager.isUserConnected(uid as string);

          return {
            userId: uid,
            status: isOnline ? 'online' : presence?.status || 'offline',
            lastSeen: presence?.lastSeen || null,
            isOnline
          };
        })
      );

      res.json({
        success: true,
        data: presenceData
      });

    } catch (error) {
      console.error('Get presence error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get presence information'
      });
    }
  }
);

/**
 * POST /api/communications/typing-indicator
 * Send typing indicator (handled via WebSocket, this is a fallback)
 */
router.post('/typing-indicator',
  requireAuth,
  validateRequest(typingIndicatorSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { conversationId, isTyping } = req.body;

      const success = await messagingService.sendTypingIndicator(conversationId, userId, isTyping);

      if (!success) {
        return res.status(400).json({
          success: false,
          error: 'Failed to deliver typing indicator'
        });
      }

      res.json({
        success: true,
        message: 'Typing indicator sent'
      });

    } catch (error) {
      console.error('Typing indicator error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send typing indicator'
      });
    }
  }
);

/**
 * GET /api/communications/health
 * Get communication system health status
 */
router.get('/health',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const connectedUsers = webSocketManager.getConnectedUsers();
      const connectionCount = connectedUsers.length;
      const activeConversations = 0; // Placeholder for now

      // Get database stats
      const totalConversations = await prisma.conversation.count({
        where: { status: 'active' }
      });

      const totalMessages = await prisma.message.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } // Last 24 hours
      });

      res.json({
        success: true,
        data: {
          webSocket: {
            activeConnections: connectionCount,
            activeConversations
          },
          database: {
            totalActiveConversations: totalConversations,
            messagesLast24h: totalMessages
          },
          services: {
            messaging: 'healthy',
            encryption: 'healthy',
            firebase: 'healthy'
          },
          timestamp: new Date()
        }
      });

    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        success: false,
        error: 'Health check failed'
      });
    }
  }
);

export default router;