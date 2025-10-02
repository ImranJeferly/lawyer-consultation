import { Server as SocketIOServer, Socket } from 'socket.io';
import prisma from '../config/database';
import { verifyToken } from '@clerk/backend';
import { clerkJwtVerification } from '../config/clerk';
import notificationService from './notification.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';
import { NotificationChannel, NotificationPriority, NotificationType } from '@prisma/client';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  clerkUserId?: string;
  userRole?: string;
  displayName?: string;
}

type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

class WebSocketManagerService {
  private io: SocketIOServer | null = null;
  private socketToUser = new Map<string, string>();
  private userToSockets = new Map<string, Set<string>>();
  private lastHeartbeat = new Map<string, number>();
  private heartbeatMonitor: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 90_000;

  initialize(io: SocketIOServer): void {
    this.io = io;
    this.registerMiddleware();
    io.on('connection', (socket) => this.handleConnection(socket as AuthenticatedSocket));

    loggingService.log(LogLevel.INFO, LogCategory.SYSTEM, 'WebSocket manager initialized');
    this.startHeartbeatMonitor();
  }

  private registerMiddleware(): void {
    if (!this.io) return;

    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth?.token || this.extractBearer(socket.handshake.headers.authorization);
        if (!token) {
          return next(new Error('Authentication token missing'));
        }

        const payload = await verifyToken(token, clerkJwtVerification as any);
        if (!payload || typeof payload !== 'object' || !('sub' in payload)) {
          return next(new Error('Invalid authentication token'));
        }

        const clerkUserId = String((payload as Record<string, unknown>).sub);
        const user = await prisma.user.findUnique({
          where: { clerkUserId },
          select: { id: true, role: true, firstName: true, lastName: true }
        });

        if (!user) {
          return next(new Error('User not provisioned'));
        }

        socket.userId = user.id;
        socket.clerkUserId = clerkUserId;
        socket.userRole = user.role;
        socket.displayName = `${user.firstName} ${user.lastName}`.trim();

        next();
      } catch (error) {
        loggingService.logError(error as Error, undefined, {
          operation: 'websocket_authenticate'
        });
        next(new Error('Authentication failed'));
      }
    });
  }

  private extractBearer(header?: string): string | undefined {
    if (!header) return undefined;
    if (!header.toLowerCase().startsWith('bearer ')) return undefined;
    return header.slice(7);
  }

  private async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.userId) {
      socket.disconnect(true);
      return;
    }

    this.addSocket(socket.userId, socket.id);
    socket.join(this.userRoom(socket.userId));
    this.lastHeartbeat.set(socket.id, Date.now());

    await this.joinExistingConversations(socket);
    await this.updatePresence(socket.userId, 'online');

    socket.emit('connection:ack', {
      userId: socket.userId,
      connectedAt: new Date().toISOString()
    });

    socket.emit('heartbeat:request', {
      serverTime: new Date().toISOString()
    });

    socket.on('conversation:join', (payload) => this.handleJoinConversation(socket, payload));
    socket.on('conversation:leave', (payload) => this.handleLeaveConversation(socket, payload));
    socket.on('typing:start', (payload) => this.handleTypingStart(socket, payload));
    socket.on('typing:stop', (payload) => this.handleTypingStop(socket, payload));
    socket.on('presence:update', (payload) => this.handlePresenceUpdate(socket, payload));
    socket.on('heartbeat', (payload) => this.handleHeartbeat(socket, payload));
    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  private async joinExistingConversations(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.userId) return;

    try {
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

      for (const conversation of conversations) {
        socket.join(this.conversationRoom(conversation.id));
      }

      if (conversations.length) {
        loggingService.log(LogLevel.DEBUG, LogCategory.USER_ACTION, 'Socket joined conversations', {
          userId: socket.userId,
          conversationCount: conversations.length
        });
      }
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'websocket_join_existing_conversations',
        userId: socket.userId
      });
    }
  }

  private async handleJoinConversation(socket: AuthenticatedSocket, payload: any): Promise<void> {
    if (!socket.userId) return;

    const { conversationId } = payload ?? {};
    if (!conversationId) {
      socket.emit('conversation:error', {
        message: 'conversationId is required'
      });
      return;
    }

    try {
      const canAccess = await this.userCanAccessConversation(socket.userId, conversationId);
      if (!canAccess) {
        socket.emit('conversation:error', {
          conversationId,
          message: 'Access denied'
        });
        return;
      }

      socket.join(this.conversationRoom(conversationId));
      socket.emit('conversation:joined', {
        conversationId,
        joinedAt: new Date().toISOString()
      });

      this.emitToConversation(conversationId, 'presence:joined', {
        userId: socket.userId,
        timestamp: new Date().toISOString()
      }, { excludeUserId: socket.userId }).catch(() => undefined);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'websocket_join_conversation',
        userId: socket.userId,
        conversationId
      });

      socket.emit('conversation:error', {
        conversationId,
        message: 'Failed to join conversation'
      });
    }
  }

  private async handleLeaveConversation(socket: AuthenticatedSocket, payload: any): Promise<void> {
    if (!socket.userId) return;

    const { conversationId } = payload ?? {};
    if (!conversationId) return;

    socket.leave(this.conversationRoom(conversationId));
    socket.emit('conversation:left', {
      conversationId,
      leftAt: new Date().toISOString()
    });

    this.emitToConversation(conversationId, 'presence:left', {
      userId: socket.userId,
      timestamp: new Date().toISOString()
    }, { excludeUserId: socket.userId }).catch(() => undefined);
  }

  private async handleTypingStart(socket: AuthenticatedSocket, payload: any): Promise<void> {
    if (!socket.userId) return;

    const { conversationId } = payload ?? {};
    if (!conversationId) return;

    const canAccess = await this.userCanAccessConversation(socket.userId, conversationId);
    if (!canAccess) return;

    this.emitToConversation(conversationId, 'typing', {
      conversationId,
      userId: socket.userId,
      isTyping: true,
      timestamp: new Date().toISOString()
    }, { excludeUserId: socket.userId }).catch(() => undefined);
  }

  private async handleTypingStop(socket: AuthenticatedSocket, payload: any): Promise<void> {
    if (!socket.userId) return;

    const { conversationId } = payload ?? {};
    if (!conversationId) return;

    const canAccess = await this.userCanAccessConversation(socket.userId, conversationId);
    if (!canAccess) return;

    this.emitToConversation(conversationId, 'typing', {
      conversationId,
      userId: socket.userId,
      isTyping: false,
      timestamp: new Date().toISOString()
    }, { excludeUserId: socket.userId }).catch(() => undefined);
  }

  private async handlePresenceUpdate(socket: AuthenticatedSocket, payload: any): Promise<void> {
    if (!socket.userId) return;

    const { status } = payload ?? {};
    const normalizedStatus: PresenceStatus = ['online', 'away', 'busy'].includes(status) ? status : 'online';
    await this.updatePresence(socket.userId, normalizedStatus);
  }

  private handleHeartbeat(socket: AuthenticatedSocket, payload?: Record<string, unknown>): void {
    this.lastHeartbeat.set(socket.id, Date.now());
    socket.emit('heartbeat:ack', {
      timestamp: new Date().toISOString(),
      ...(payload ?? {})
    });
  }

  private async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.userId) return;

    this.removeSocket(socket.userId, socket.id);
    this.lastHeartbeat.delete(socket.id);

    const stillConnected = this.isUserConnected(socket.userId);
    if (!stillConnected) {
      await this.updatePresence(socket.userId, 'offline');
    }
  }

  private addSocket(userId: string, socketId: string): void {
    this.socketToUser.set(socketId, userId);
    if (!this.userToSockets.has(userId)) {
      this.userToSockets.set(userId, new Set());
    }
    this.userToSockets.get(userId)!.add(socketId);
  }

  private removeSocket(userId: string, socketId: string): void {
    this.socketToUser.delete(socketId);
    const sockets = this.userToSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.userToSockets.delete(userId);
    }
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private conversationRoom(conversationId: string): string {
    return `conversation:${conversationId}`;
  }

  private async userCanAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { clientId: true, lawyerId: true }
    });

    if (!conversation) {
      return false;
    }

    return conversation.clientId === userId || conversation.lawyerId === userId;
  }

  private startHeartbeatMonitor(): void {
    if (this.heartbeatMonitor) {
      return;
    }

    this.heartbeatMonitor = setInterval(() => {
      if (!this.io) {
        return;
      }

      const now = Date.now();
      const staleEntries: Array<{ socketId: string; userId?: string }> = [];

      for (const [socketId, lastSeen] of this.lastHeartbeat.entries()) {
        const elapsed = now - lastSeen;

        if (elapsed > WebSocketManagerService.HEARTBEAT_TIMEOUT_MS) {
          const userId = this.socketToUser.get(socketId);
          staleEntries.push({ socketId, userId });

          const socket = this.io.of('/').sockets.get(socketId) as AuthenticatedSocket | undefined;
          if (socket) {
            socket.emit('connection:stale', {
              reason: 'heartbeat_timeout',
              serverTime: new Date().toISOString()
            });
            socket.disconnect(true);
          }

          loggingService.log(LogLevel.WARN, LogCategory.SYSTEM, 'Disconnected stale WebSocket connection', {
            socketId,
            userId,
            elapsed
          });
        } else if (elapsed > WebSocketManagerService.HEARTBEAT_INTERVAL_MS) {
          this.io.to(socketId).emit('heartbeat:request', {
            serverTime: new Date().toISOString()
          });
        }
      }

      staleEntries.forEach(({ socketId, userId }) => {
        this.lastHeartbeat.delete(socketId);
        if (userId) {
          this.removeSocket(userId, socketId);
          if (!this.isUserConnected(userId)) {
            this.updatePresence(userId, 'offline').catch((error) => {
              loggingService.logError(error as Error, undefined, {
                operation: 'websocket_presence_timeout',
                userId
              });
            });
          }
        }
      });
    }, WebSocketManagerService.HEARTBEAT_INTERVAL_MS);
  }

  private async updatePresence(userId: string, status: PresenceStatus): Promise<void> {
    try {
      await prisma.userPresence.upsert({
        where: { userId },
        update: {
          status,
          lastSeen: new Date()
        },
        create: {
          userId,
          status,
          lastSeen: new Date()
        }
      });

      this.emitToUser(userId, 'presence:updated', {
        status,
        timestamp: new Date().toISOString()
      }).catch(() => undefined);
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'websocket_update_presence',
        userId,
        status
      });
    }
  }

  public async emitToConversation(
    conversationId: string,
    event: string,
    payload: unknown,
    options?: { excludeUserId?: string }
  ): Promise<void> {
    if (!this.io) return;

    const roomName = this.conversationRoom(conversationId);
    const room = this.io.of('/').adapter.rooms.get(roomName);

    if (!room) {
      return;
    }

    const excludedSockets = options?.excludeUserId ? this.userToSockets.get(options.excludeUserId) : undefined;

    room.forEach((socketId) => {
      if (excludedSockets && excludedSockets.has(socketId)) {
        return;
      }
      this.io!.to(socketId).emit(event, payload);
    });
  }

  public async emitToUser(userId: string, event: string, payload: unknown): Promise<void> {
    if (!this.io) return;
    const sockets = this.userToSockets.get(userId);
    if (!sockets) return;

    sockets.forEach((socketId) => {
      this.io!.to(socketId).emit(event, payload);
    });
  }

  public async broadcastToRoom(room: string, event: string, payload: unknown): Promise<void> {
    if (!this.io) return;
    this.io.to(room).emit(event, payload);
  }

  public isUserConnected(userId: string): boolean {
    return (this.userToSockets.get(userId)?.size ?? 0) > 0;
  }

  public getConnectedUsers(): string[] {
    return Array.from(this.userToSockets.keys());
  }

  public async notifyOfflineParticipants(
    conversationId: string,
    triggeringUserId: string,
    notification: { title: string; message: string; type: NotificationType; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        clientId: true,
        lawyerId: true
      }
    });

    if (!conversation) {
      return;
    }

    const recipients = [conversation.clientId, conversation.lawyerId].filter((id) => id && id !== triggeringUserId);

    await Promise.all(recipients.map(async (recipientId) => {
      if (this.isUserConnected(recipientId)) {
        return;
      }

      try {
        await notificationService.sendNotification({
          recipientId,
          title: notification.title,
          message: notification.message,
          notificationType: notification.type,
          channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
          priority: NotificationPriority.HIGH,
          metadata: {
            conversationId,
            ...notification.metadata
          }
        });
      } catch (error) {
        loggingService.logError(error as Error, undefined, {
          operation: 'notify_offline_participant',
          conversationId,
          recipientId
        });
      }
    }));
  }
}

export default new WebSocketManagerService();
