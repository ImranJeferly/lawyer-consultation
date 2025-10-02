import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import firebaseService from './firebase.service';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
}

interface UserConnection {
  userId: string;
  socketId: string;
  userRole: string;
  connectionTime: Date;
  lastActivity: Date;
  ipAddress: string;
  userAgent: string;
}

interface TypingUser {
  userId: string;
  userName: string;
  startedAt: Date;
}

interface MessageDeliveryStatus {
  messageId: string;
  userId: string;
  status: 'sent' | 'delivered' | 'read';
  timestamp: Date;
}

class WebSocketManager {
  private io: SocketIOServer | null = null;
  private connections = new Map<string, UserConnection>(); // socketId -> connection
  private userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds
  private conversationRooms = new Map<string, Set<string>>(); // conversationId -> Set of userIds
  private typingUsers = new Map<string, Map<string, TypingUser>>(); // conversationId -> userId -> TypingUser

  // Heartbeat tracking
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 60000; // 1 minute

  initialize(io: SocketIOServer): void {
    this.io = io;
    this.setupMiddleware();
    this.setupEventHandlers();
    this.startHeartbeat();

    console.log('WebSocket Manager initialized');
  }

  private setupMiddleware(): void {
    if (!this.io) return;

    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

        if (!token) {
          return next(new Error('Authentication token required'));
        }

        // Verify JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

        // Get user details from database
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { id: true, role: true, firstName: true, lastName: true }
        });

        if (!user) {
          return next(new Error('User not found'));
        }

        socket.userId = user.id;
        socket.userRole = user.role;

        next();
      } catch (error) {
        console.error('WebSocket authentication error:', error);
        next(new Error('Authentication failed'));
      }
    });
  }

  private setupEventHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket: AuthenticatedSocket) => {
      this.handleConnection(socket);
    });
  }

  private handleConnection(socket: AuthenticatedSocket): void {
    if (!socket.userId) return;

    console.log(`User ${socket.userId} connected via WebSocket`);

    // Store connection
    const connection: UserConnection = {
      userId: socket.userId,
      socketId: socket.id,
      userRole: socket.userRole!,
      connectionTime: new Date(),
      lastActivity: new Date(),
      ipAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'] || ''
    };

    this.connections.set(socket.id, connection);

    // Add to user's socket list
    if (!this.userSockets.has(socket.userId)) {
      this.userSockets.set(socket.userId, new Set());
    }
    this.userSockets.get(socket.userId)!.add(socket.id);

    // Update user presence
    this.updateUserPresence(socket.userId, 'online');

    // Join user to their personal room
    socket.join(`user:${socket.userId}`);

    // Join user to their conversation rooms
    this.joinUserConversations(socket);

    // Set up event handlers
    this.setupSocketEventHandlers(socket);

    // Send connection confirmation
    socket.emit('connected', {
      userId: socket.userId,
      connectionTime: connection.connectionTime,
      serverTime: new Date()
    });
  }

  private async joinUserConversations(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.userId) return;

    try {
      // Get all active conversations for this user
      const conversations = await prisma.conversation.findMany({
        where: {
          OR: [
            { clientId: socket.userId },
            { lawyerId: socket.userId }
          ],
          status: 'active'
        },
        select: { id: true }
      });

      // Join conversation rooms
      for (const conversation of conversations) {
        socket.join(`conversation:${conversation.id}`);

        // Add to conversation room tracking
        if (!this.conversationRooms.has(conversation.id)) {
          this.conversationRooms.set(conversation.id, new Set());
        }
        this.conversationRooms.get(conversation.id)!.add(socket.userId!);
      }

      console.log(`User ${socket.userId} joined ${conversations.length} conversation rooms`);
    } catch (error) {
      console.error('Failed to join user conversations:', error);
    }
  }

  private setupSocketEventHandlers(socket: AuthenticatedSocket): void {
    // Message events
    socket.on('send_message', (data) => this.handleSendMessage(socket, data));
    socket.on('message_read', (data) => this.handleMessageRead(socket, data));

    // Typing events
    socket.on('typing_start', (data) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', (data) => this.handleTypingStop(socket, data));

    // Video call events
    socket.on('video_call_invite', (data) => this.handleVideoCallInvite(socket, data));
    socket.on('video_call_response', (data) => this.handleVideoCallResponse(socket, data));
    socket.on('video_call_end', (data) => this.handleVideoCallEnd(socket, data));

    // Presence events
    socket.on('update_presence', (data) => this.handleUpdatePresence(socket, data));

    // Heartbeat
    socket.on('heartbeat', () => this.handleHeartbeat(socket));

    // Disconnect
    socket.on('disconnect', () => this.handleDisconnection(socket));
  }

  private async handleSendMessage(socket: AuthenticatedSocket, data: any): Promise<void> {
    if (!socket.userId) return;

    try {
      const { conversationId, content, messageType = 'TEXT', parentMessageId } = data;

      // Validate conversation access
      const hasAccess = await this.validateConversationAccess(socket.userId, conversationId);
      if (!hasAccess) {
        socket.emit('error', { message: 'Access denied to conversation' });
        return;
      }

      // The actual message creation will be handled by the messaging service
      // This WebSocket handler just manages real-time delivery

      // Broadcast to conversation room (excluding sender)
      socket.to(`conversation:${conversationId}`).emit('message_received', {
        conversationId,
        senderId: socket.userId,
        content,
        messageType,
        parentMessageId,
        timestamp: new Date()
      });

      // Update conversation activity
      this.updateConversationActivity(conversationId);

      console.log(`Message sent in conversation ${conversationId} by user ${socket.userId}`);

    } catch (error) {
      console.error('Failed to handle send message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  }

  private async handleMessageRead(socket: AuthenticatedSocket, data: any): Promise<void> {
    if (!socket.userId) return;

    try {
      const { messageId, conversationId } = data;

      // Broadcast read receipt to conversation participants
      socket.to(`conversation:${conversationId}`).emit('message_read', {
        messageId,
        conversationId,
        readBy: socket.userId,
        readAt: new Date()
      });

      console.log(`Message ${messageId} read by user ${socket.userId}`);

    } catch (error) {
      console.error('Failed to handle message read:', error);
    }
  }

  private handleTypingStart(socket: AuthenticatedSocket, data: any): void {
    if (!socket.userId) return;

    const { conversationId } = data;

    // Add to typing users
    if (!this.typingUsers.has(conversationId)) {
      this.typingUsers.set(conversationId, new Map());
    }

    this.typingUsers.get(conversationId)!.set(socket.userId, {
      userId: socket.userId,
      userName: `User ${socket.userId}`, // In production, get actual name
      startedAt: new Date()
    });

    // Broadcast to other participants
    socket.to(`conversation:${conversationId}`).emit('user_typing', {
      conversationId,
      userId: socket.userId,
      isTyping: true
    });

    // Auto-stop typing after 10 seconds
    setTimeout(() => {
      this.handleTypingStop(socket, { conversationId });
    }, 10000);
  }

  private handleTypingStop(socket: AuthenticatedSocket, data: any): void {
    if (!socket.userId) return;

    const { conversationId } = data;

    // Remove from typing users
    if (this.typingUsers.has(conversationId)) {
      this.typingUsers.get(conversationId)!.delete(socket.userId);

      // Broadcast stop typing
      socket.to(`conversation:${conversationId}`).emit('user_typing', {
        conversationId,
        userId: socket.userId,
        isTyping: false
      });
    }
  }

  private async handleVideoCallInvite(socket: AuthenticatedSocket, data: any): Promise<void> {
    if (!socket.userId) return;

    try {
      const { conversationId, roomId, appointmentId } = data;

      // Validate access
      const hasAccess = await this.validateConversationAccess(socket.userId, conversationId);
      if (!hasAccess) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      // Broadcast video call invitation
      socket.to(`conversation:${conversationId}`).emit('video_call_invitation', {
        conversationId,
        roomId,
        appointmentId,
        invitedBy: socket.userId,
        timestamp: new Date()
      });

      // Send push notification to offline users
      await this.notifyOfflineUsers(conversationId, socket.userId, {
        type: 'video_call_invitation',
        data: { conversationId, roomId, appointmentId }
      });

    } catch (error) {
      console.error('Failed to handle video call invite:', error);
    }
  }

  private handleVideoCallResponse(socket: AuthenticatedSocket, data: any): void {
    if (!socket.userId) return;

    const { conversationId, roomId, accepted } = data;

    socket.to(`conversation:${conversationId}`).emit('video_call_response', {
      conversationId,
      roomId,
      respondedBy: socket.userId,
      accepted,
      timestamp: new Date()
    });
  }

  private handleVideoCallEnd(socket: AuthenticatedSocket, data: any): void {
    if (!socket.userId) return;

    const { conversationId, roomId, duration } = data;

    socket.to(`conversation:${conversationId}`).emit('video_call_ended', {
      conversationId,
      roomId,
      endedBy: socket.userId,
      duration,
      timestamp: new Date()
    });
  }

  private async handleUpdatePresence(socket: AuthenticatedSocket, data: any): Promise<void> {
    if (!socket.userId) return;

    const { status } = data; // online, away, busy
    await this.updateUserPresence(socket.userId, status);
  }

  private handleHeartbeat(socket: AuthenticatedSocket): void {
    const connection = this.connections.get(socket.id);
    if (connection) {
      connection.lastActivity = new Date();
      socket.emit('heartbeat_ack', { timestamp: new Date() });
    }
  }

  private async handleDisconnection(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.userId) return;

    console.log(`User ${socket.userId} disconnected from WebSocket`);

    // Remove from connections
    this.connections.delete(socket.id);

    // Remove from user's socket list
    const userSockets = this.userSockets.get(socket.userId);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        this.userSockets.delete(socket.userId);
        // User has no more connections, update presence to offline
        await this.updateUserPresence(socket.userId, 'offline');
      }
    }

    // Remove from conversation rooms
    for (const [conversationId, users] of this.conversationRooms) {
      users.delete(socket.userId);
    }

    // Stop typing in all conversations
    for (const [conversationId, typingUsers] of this.typingUsers) {
      if (typingUsers.has(socket.userId)) {
        typingUsers.delete(socket.userId);
        // Notify other users
        socket.to(`conversation:${conversationId}`).emit('user_typing', {
          conversationId,
          userId: socket.userId,
          isTyping: false
        });
      }
    }
  }

  // Public methods for external services to use

  async sendMessageToUser(userId: string, event: string, data: any): Promise<boolean> {
    const userSockets = this.userSockets.get(userId);
    if (!userSockets || userSockets.size === 0) {
      return false; // User not connected
    }

    if (this.io) {
      this.io.to(`user:${userId}`).emit(event, data);
      return true;
    }

    return false;
  }

  async sendMessage(conversationId: string, event: string, data: any, excludeUserId?: string): Promise<void> {
    if (!this.io) return;

    if (excludeUserId) {
      // Get all sockets in conversation except the excluded user
      const excludedSockets = this.userSockets.get(excludeUserId) || new Set();
      const allSockets = this.io.sockets.adapter.rooms.get(`conversation:${conversationId}`) || new Set();

      for (const socketId of allSockets) {
        if (!excludedSockets.has(socketId)) {
          this.io.to(socketId).emit(event, data);
        }
      }
    } else {
      this.io.to(`conversation:${conversationId}`).emit(event, data);
    }
  }

  isConnected(userId: string): boolean {
    return this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0;
  }

  getOnlineUsersInConversation(conversationId: string): string[] {
    const users = this.conversationRooms.get(conversationId);
    if (!users) return [];

    return Array.from(users).filter(userId => this.isConnected(userId));
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getActiveConversations(): number {
    return this.conversationRooms.size;
  }

  // Private helper methods

  private async validateConversationAccess(userId: string, conversationId: string): Promise<boolean> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      return conversation?.clientId === userId || conversation?.lawyerId === userId;
    } catch (error) {
      console.error('Failed to validate conversation access:', error);
      return false;
    }
  }

  private async updateUserPresence(userId: string, status: string): Promise<void> {
    try {
      await prisma.userPresence.upsert({
        where: { userId },
        create: {
          userId,
          status,
          lastSeen: new Date()
        },
        update: {
          status,
          lastSeen: new Date()
        }
      });

      // Broadcast presence update to relevant users
      if (this.io) {
        this.io.emit('user_presence_update', {
          userId,
          status,
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('Failed to update user presence:', error);
    }
  }

  private updateConversationActivity(conversationId: string): void {
    // Update conversation last activity (can be done async)
    prisma.conversation.update({
      where: { id: conversationId },
      data: { lastActivityAt: new Date() }
    }).catch(error => {
      console.error('Failed to update conversation activity:', error);
    });
  }

  private async notifyOfflineUsers(conversationId: string, excludeUserId: string, notification: any): Promise<void> {
    try {
      // Get conversation participants
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      if (!conversation) return;

      const participants = [conversation.clientId, conversation.lawyerId].filter(id => id !== excludeUserId);

      for (const participantId of participants) {
        if (!this.isConnected(participantId)) {
          // Send push notification
          await firebaseService.sendNotificationToUser(
            { userId: participantId },
            {
              title: 'New Activity',
              body: notification.type === 'video_call_invitation' ? 'Incoming video call' : 'New message',
              data: notification.data
            }
          );
        }
      }
    } catch (error) {
      console.error('Failed to notify offline users:', error);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.performHeartbeatCheck();
    }, this.HEARTBEAT_INTERVAL);
  }

  private performHeartbeatCheck(): void {
    const now = new Date();
    const timeoutThreshold = new Date(now.getTime() - this.CONNECTION_TIMEOUT);

    for (const [socketId, connection] of this.connections) {
      if (connection.lastActivity < timeoutThreshold) {
        console.log(`Connection ${socketId} timed out, disconnecting...`);
        const socket = this.io?.sockets.sockets.get(socketId);
        if (socket) {
          socket.disconnect(true);
        }
      }
    }
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.connections.clear();
    this.userSockets.clear();
    this.conversationRooms.clear();
    this.typingUsers.clear();

    console.log('WebSocket Manager shutdown complete');
  }
}

// Create singleton instance
const webSocketManager = new WebSocketManager();

export default webSocketManager;