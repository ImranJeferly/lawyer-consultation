import { initializeApp, cert, App } from 'firebase-admin/app';
import { getMessaging, Messaging, Message } from 'firebase-admin/messaging';
import prisma from '../config/database';

interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  clickAction?: string;
}

interface NotificationTarget {
  userId: string;
  fcmToken?: string;
}

class FirebaseService {
  private app: App | null = null;
  private messaging: Messaging | null = null;

  constructor() {
    this.initializeFirebase();
  }

  private initializeFirebase(): void {
    try {
      // Initialize Firebase Admin SDK (SERVER-SIDE ONLY)
      // This is for sending notifications TO Flutter apps, not receiving them
      const fs = require('fs');
      const serviceAccountPath = './firebase-service-account.json';

      if (fs.existsSync(serviceAccountPath)) {
        this.app = initializeApp({
          credential: cert(serviceAccountPath)
        });
        console.log('🔥 Firebase Admin SDK initialized (for sending notifications)');
      }
      // Priority 2: Use environment variables
      else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        this.app = initializeApp({
          credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          })
        });
        console.log('🔥 Firebase Admin SDK initialized (for sending notifications)');
      }
      // No configuration found - Firebase optional for backend
      else {
        console.log('ℹ️  Firebase not configured - push notifications disabled');
        console.log('   (Flutter app will handle Firebase client-side)');
        return;
      }

      this.messaging = getMessaging(this.app);
      console.log('📤 Ready to send push notifications to Flutter clients');
    } catch (error) {
      console.log('⚠️  Firebase Admin SDK not available:', (error as Error).message);
      console.log('   Backend will work without push notifications');
    }
  }

  /**
   * Check if Firebase is available
   */
  isAvailable(): boolean {
    return this.messaging !== null;
  }

  /**
   * Update user's FCM token
   */
  async updateFCMToken(userId: string, fcmToken: string): Promise<boolean> {
    try {
      // Update or create communication settings with FCM token
      await prisma.communicationSettings.upsert({
        where: { userId },
        create: {
          userId,
          fcmToken,
          fcmTokenUpdatedAt: new Date()
        },
        update: {
          fcmToken,
          fcmTokenUpdatedAt: new Date()
        }
      });

      console.log(`FCM token updated for user ${userId}`);
      return true;
    } catch (error) {
      console.error('Failed to update FCM token:', error);
      return false;
    }
  }

  /**
   * Send push notification to a specific user
   */
  async sendNotificationToUser(
    target: NotificationTarget,
    notification: PushNotificationData
  ): Promise<boolean> {
    if (!this.messaging) {
      console.warn('Firebase messaging not initialized. Skipping notification.');
      return false;
    }

    try {
      // Get user's FCM token if not provided
      let fcmToken = target.fcmToken;
      if (!fcmToken) {
        const settings = await prisma.communicationSettings.findUnique({
          where: { userId: target.userId }
        });
        fcmToken = settings?.fcmToken || undefined;
      }

      if (!fcmToken) {
        console.log(`No FCM token found for user ${target.userId}`);
        return false;
      }

      // Check if user has push notifications enabled
      const settings = await prisma.communicationSettings.findUnique({
        where: { userId: target.userId }
      });

      if (!settings?.pushNotifications) {
        console.log(`Push notifications disabled for user ${target.userId}`);
        return false;
      }

      // Prepare message
      const message: Message = {
        token: fcmToken,
        notification: {
          title: notification.title,
          body: notification.body,
          imageUrl: notification.imageUrl
        },
        data: notification.data || {},
        webpush: notification.clickAction ? {
          fcmOptions: {
            link: notification.clickAction
          }
        } : undefined
      };

      // Send the message
      const response = await this.messaging.send(message);
      console.log(`Push notification sent successfully to ${target.userId}:`, response);
      return true;

    } catch (error: any) {
      console.error(`Failed to send push notification to ${target.userId}:`, error);

      // If token is invalid, remove it from database
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        await this.removeFCMToken(target.userId);
      }

      return false;
    }
  }

  /**
   * Send notifications to multiple users
   */
  async sendNotificationToMultipleUsers(
    targets: NotificationTarget[],
    notification: PushNotificationData
  ): Promise<{ successCount: number; failureCount: number }> {
    let successCount = 0;
    let failureCount = 0;

    for (const target of targets) {
      const success = await this.sendNotificationToUser(target, notification);
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    return { successCount, failureCount };
  }

  /**
   * Send notification about new message
   */
  async sendMessageNotification(
    recipientUserId: string,
    senderName: string,
    messageContent: string,
    conversationId: string
  ): Promise<boolean> {
    return this.sendNotificationToUser(
      { userId: recipientUserId },
      {
        title: `New message from ${senderName}`,
        body: messageContent.length > 100 ? `${messageContent.substring(0, 100)}...` : messageContent,
        data: {
          type: 'message',
          conversationId,
          senderId: senderName
        },
        clickAction: `/conversations/${conversationId}`
      }
    );
  }

  /**
   * Send notification about new appointment
   */
  async sendAppointmentNotification(
    recipientUserId: string,
    appointmentDetails: {
      title: string;
      startTime: Date;
      lawyerName?: string;
      clientName?: string;
    },
    appointmentId: string
  ): Promise<boolean> {
    const { title, startTime, lawyerName, clientName } = appointmentDetails;
    const formattedTime = startTime.toLocaleString();

    return this.sendNotificationToUser(
      { userId: recipientUserId },
      {
        title: 'New Appointment Scheduled',
        body: `${title} scheduled for ${formattedTime}${lawyerName ? ` with ${lawyerName}` : ''}`,
        data: {
          type: 'appointment',
          appointmentId,
          startTime: startTime.toISOString(),
          lawyerName: lawyerName || '',
          clientName: clientName || ''
        },
        clickAction: `/appointments/${appointmentId}`
      }
    );
  }

  /**
   * Send notification about video call
   */
  async sendVideoCallNotification(
    recipientUserId: string,
    callerName: string,
    roomId: string,
    appointmentId?: string
  ): Promise<boolean> {
    return this.sendNotificationToUser(
      { userId: recipientUserId },
      {
        title: 'Incoming Video Call',
        body: `${callerName} is calling you`,
        data: {
          type: 'video_call',
          roomId,
          callerName,
          appointmentId: appointmentId || ''
        },
        clickAction: `/video/${roomId}`
      }
    );
  }

  /**
   * Send appointment reminder notification
   */
  async sendAppointmentReminder(
    recipientUserId: string,
    appointmentDetails: {
      title: string;
      startTime: Date;
      lawyerName?: string;
      clientName?: string;
    },
    appointmentId: string,
    minutesUntil: number
  ): Promise<boolean> {
    const { title, lawyerName, clientName } = appointmentDetails;
    const reminderText = minutesUntil === 0
      ? 'now'
      : minutesUntil < 60
        ? `in ${minutesUntil} minutes`
        : `in ${Math.floor(minutesUntil / 60)} hour${Math.floor(minutesUntil / 60) > 1 ? 's' : ''}`;

    return this.sendNotificationToUser(
      { userId: recipientUserId },
      {
        title: 'Appointment Reminder',
        body: `Your consultation "${title}"${lawyerName ? ` with ${lawyerName}` : ''} starts ${reminderText}`,
        data: {
          type: 'appointment_reminder',
          appointmentId,
          minutesUntil: minutesUntil.toString(),
          lawyerName: lawyerName || '',
          clientName: clientName || ''
        },
        clickAction: `/appointments/${appointmentId}`
      }
    );
  }

  /**
   * Remove FCM token for a user (when token becomes invalid)
   */
  private async removeFCMToken(userId: string): Promise<void> {
    try {
      await prisma.communicationSettings.update({
        where: { userId },
        data: {
          fcmToken: null,
          fcmTokenUpdatedAt: null
        }
      });
      console.log(`Removed invalid FCM token for user ${userId}`);
    } catch (error) {
      console.error(`Failed to remove FCM token for user ${userId}:`, error);
    }
  }

  /**
   * Send bulk notifications (used for system announcements)
   */
  async sendBulkNotification(
    userIds: string[],
    notification: PushNotificationData
  ): Promise<{ successCount: number; failureCount: number }> {
    if (!this.messaging) {
      console.warn('Firebase messaging not initialized. Skipping bulk notification.');
      return { successCount: 0, failureCount: userIds.length };
    }

    try {
      // Get all FCM tokens for the users
      const settings = await prisma.communicationSettings.findMany({
        where: {
          userId: { in: userIds },
          fcmToken: { not: null },
          pushNotifications: true
        },
        select: {
          userId: true,
          fcmToken: true
        }
      });

      if (settings.length === 0) {
        console.log('No valid FCM tokens found for bulk notification');
        return { successCount: 0, failureCount: userIds.length };
      }

      const tokens = settings.map(s => s.fcmToken!);

      // Prepare multicast message
      const message = {
        tokens,
        notification: {
          title: notification.title,
          body: notification.body,
          imageUrl: notification.imageUrl
        },
        data: notification.data || {},
        webpush: notification.clickAction ? {
          fcmOptions: {
            link: notification.clickAction
          }
        } : undefined
      };

      // Send to multiple devices
      const response = await this.messaging.sendEachForMulticast(message);

      console.log(`Bulk notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

      // Handle invalid tokens
      if (response.failureCount > 0) {
        response.responses.forEach(async (resp, idx) => {
          if (!resp.success &&
              (resp.error?.code === 'messaging/invalid-registration-token' ||
               resp.error?.code === 'messaging/registration-token-not-registered')) {
            await this.removeFCMToken(settings[idx].userId);
          }
        });
      }

      return {
        successCount: response.successCount,
        failureCount: response.failureCount
      };

    } catch (error) {
      console.error('Failed to send bulk notification:', error);
      return { successCount: 0, failureCount: userIds.length };
    }
  }
}

// Create singleton instance
const firebaseService = new FirebaseService();

export default firebaseService;
export { PushNotificationData, NotificationTarget };