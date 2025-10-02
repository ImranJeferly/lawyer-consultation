import {
  DeliveryStatus,
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
  Prisma
} from '@prisma/client';
import prisma from '../config/database';
import notificationTemplateService from './notification-template.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';

type SendNotificationOptions = {
  recipientId: string;
  title: string;
  message: string;
  notificationType?: NotificationType | string;
  category?: NotificationCategory | string;
  priority?: NotificationPriority | string;
  status?: NotificationPriority | string;
  channels?: (NotificationChannel | string)[];
  recipientEmail?: string;
  recipientPhone?: string;
  recipientName?: string;
  senderId?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
  templateId?: string;
  templateVariables?: Record<string, unknown>;
  scheduledFor?: Date | string;
  respectQuietHours?: boolean;
  overridePreferences?: boolean;
  urgentOverride?: boolean;
  contextType?: string;
  contextId?: string;
  richContent?: Record<string, unknown>;
};

const LEGACY_TYPE_MAP: Record<string, NotificationType> = {
  BOOKING_CONFIRMED: NotificationType.APPOINTMENT_CONFIRMATION,
  BOOKING_CONFIRMATION: NotificationType.APPOINTMENT_CONFIRMATION,
  NEW_BOOKING: NotificationType.APPOINTMENT_CONFIRMATION,
  BOOKING_CANCELLED: NotificationType.APPOINTMENT_CANCELLED,
  BOOKING_RESCHEDULED: NotificationType.APPOINTMENT_RESCHEDULED,
  APPOINTMENT_REMINDER: NotificationType.APPOINTMENT_REMINDER_1H,
  URGENT_MESSAGE: NotificationType.NEW_MESSAGE,
  MESSAGE_RECEIVED: NotificationType.NEW_MESSAGE,
  CALL_INCOMING: NotificationType.VIDEO_CALL_INVITATION,
  PAYMENT_CONFIRMATION: NotificationType.PAYMENT_CAPTURED,
  SYSTEM_UPDATE: NotificationType.SYSTEM_MAINTENANCE,
  ACCOUNT_SECURITY: NotificationType.SECURITY_ALERT
};

const NOTIFICATION_PRIORITY_VALUES = new Set(Object.values(NotificationPriority));
const NOTIFICATION_CHANNEL_VALUES = new Set(Object.values(NotificationChannel));
const NOTIFICATION_CATEGORY_VALUES = new Set(Object.values(NotificationCategory));
const NOTIFICATION_TYPE_VALUES = new Set(Object.values(NotificationType));

class NotificationService {
  async sendNotification(options: SendNotificationOptions): Promise<string> {
    const notificationType = this.resolveNotificationType(options.notificationType);
    const priority = this.resolvePriority(options.priority, options.status);
    const channels = this.resolveChannels(options.channels);
    const category = this.resolveCategory(options.category, notificationType);
    const scheduledForDate = this.resolveDate(options.scheduledFor);
    const metadata = options.metadata as Prisma.InputJsonValue | undefined;
    const templateVariables = options.templateVariables as Prisma.InputJsonValue | undefined;
    const richContent = options.richContent as Prisma.InputJsonValue | undefined;

    const isScheduled = Boolean(scheduledForDate && scheduledForDate.getTime() > Date.now());
    const status = isScheduled ? NotificationStatus.QUEUED : NotificationStatus.SENT;
    const emailStatus = channels.includes(NotificationChannel.EMAIL)
      ? (isScheduled ? DeliveryStatus.QUEUED : DeliveryStatus.SENT)
      : DeliveryStatus.NOT_SENT;
    const smsStatus = channels.includes(NotificationChannel.SMS)
      ? (isScheduled ? DeliveryStatus.QUEUED : DeliveryStatus.SENT)
      : DeliveryStatus.NOT_SENT;
    const pushStatus = channels.includes(NotificationChannel.PUSH)
      ? (isScheduled ? DeliveryStatus.QUEUED : DeliveryStatus.SENT)
      : DeliveryStatus.NOT_SENT;
    const inAppStatus = channels.includes(NotificationChannel.IN_APP)
      ? (isScheduled ? DeliveryStatus.QUEUED : DeliveryStatus.SENT)
      : DeliveryStatus.NOT_SENT;

    const notification = await prisma.notification.create({
      data: {
        recipientId: options.recipientId,
        recipientEmail: options.recipientEmail ?? null,
        recipientPhone: options.recipientPhone ?? null,
        recipientName: options.recipientName ?? null,
        senderId: options.senderId ?? null,
        senderName: options.senderName ?? null,
        title: options.title,
        message: options.message,
        notificationType,
        category,
        priority,
        channels: channels as unknown as Prisma.InputJsonValue,
        preferredChannel: channels[0] ?? null,
        status,
        emailStatus,
        smsStatus,
        pushStatus,
        inAppStatus,
        scheduledFor: scheduledForDate,
        templateId: options.templateId ?? null,
        templateVariables,
        metadata,
        richContent,
        contextType: options.contextType ?? null,
        contextId: options.contextId ?? null,
        ...(options.respectQuietHours !== undefined ? { respectQuietHours: options.respectQuietHours } : {}),
        ...(options.overridePreferences !== undefined ? { overridePreferences: options.overridePreferences } : {}),
        ...(options.urgentOverride !== undefined ? { urgentOverride: options.urgentOverride } : {})
      }
    });

    if (isScheduled) {
      const queueServiceModule = await import('./notification-queue.service');
      const queueService = queueServiceModule.default;
      await queueService.enqueueNotification(notification.id, scheduledForDate ?? undefined);
    } else {
      try {
        await this.deliverNotification(notification.id);
      } catch (error) {
        loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Immediate notification delivery failed', {
          notificationId: notification.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return notification.id;
  }

  async markInAppNotificationAsRead(notificationId: string, userId: string): Promise<boolean> {
    const result = await prisma.notification.updateMany({
      where: {
        id: notificationId,
        recipientId: userId
      },
      data: {
        isRead: true,
        readAt: new Date(),
        inAppStatus: DeliveryStatus.OPENED,
        status: NotificationStatus.DELIVERED
      }
    });

    return result.count > 0;
  }

  async sendEmail(to: string, subject: string, content: string): Promise<boolean> {
    console.log('Email notification (placeholder):', { to, subject, content });
    return true;
  }

  async sendSMS(to: string, message: string): Promise<boolean> {
    console.log('SMS notification (placeholder):', { to, message });
    return true;
  }

  async sendPushNotification(userId: string, title: string, body: string): Promise<boolean> {
    console.log('Push notification (placeholder):', { userId, title, body });
    return true;
  }

  async queueNotification(type: string, recipient: string, data: unknown): Promise<void> {
    console.log('Queue notification (placeholder):', { type, recipient, data });
  }

  async processNotificationQueue(): Promise<void> {
    console.log('Processing notification queue (placeholder)');
  }

  async getUserNotificationPreferences(userId: string): Promise<any> {
    console.log('Get notification preferences (placeholder):', userId);
    return {
      email: true,
      sms: false,
      push: true
    };
  }

  async updateUserNotificationPreferences(userId: string, preferences: any): Promise<boolean> {
    console.log('Update notification preferences (placeholder):', { userId, preferences });
    return true;
  }

  async deliverNotification(notificationId: string): Promise<Notification> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId }
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: NotificationStatus.SENDING,
        lastInteraction: new Date()
      }
    });

    const channels = this.normalizeChannels(notification.channels);
    const now = new Date();
    let delivered = false;
    const failures: string[] = [];

    const updateData: Prisma.NotificationUpdateInput = {
      lastInteraction: now
    };

    for (const channel of channels) {
      switch (channel) {
        case NotificationChannel.EMAIL: {
          if (!notification.recipientEmail) {
            failures.push('Missing recipient email');
            updateData.emailStatus = DeliveryStatus.FAILED;
            updateData.emailBounceReason = 'Missing recipient email';
            break;
          }

          try {
            const rendered = await this.renderNotificationContent(notification, NotificationChannel.EMAIL);
            const emailSent = await this.sendEmail(notification.recipientEmail, rendered.title, rendered.content);

            if (emailSent) {
              updateData.emailStatus = DeliveryStatus.DELIVERED;
              updateData.emailSentAt = now;
              updateData.emailDeliveredAt = now;
              delivered = true;
            } else {
              updateData.emailStatus = DeliveryStatus.FAILED;
              updateData.emailBounceReason = 'Email provider reported failure';
              failures.push('Email delivery failed');
            }
          } catch (error) {
            updateData.emailStatus = DeliveryStatus.FAILED;
            updateData.emailBounceReason = error instanceof Error ? error.message : 'Unknown email error';
            failures.push(`Email error: ${updateData.emailBounceReason}`);
          }
          break;
        }
        case NotificationChannel.SMS: {
          if (!notification.recipientPhone) {
            failures.push('Missing recipient phone');
            updateData.smsStatus = DeliveryStatus.FAILED;
            updateData.smsFailedReason = 'Missing recipient phone';
            break;
          }

          try {
            const rendered = await this.renderNotificationContent(notification, NotificationChannel.SMS);
            const smsSent = await this.sendSMS(notification.recipientPhone, rendered.content);

            if (smsSent) {
              updateData.smsStatus = DeliveryStatus.DELIVERED;
              updateData.smsSentAt = now;
              updateData.smsDeliveredAt = now;
              delivered = true;
            } else {
              updateData.smsStatus = DeliveryStatus.FAILED;
              updateData.smsFailedReason = 'SMS provider reported failure';
              failures.push('SMS delivery failed');
            }
          } catch (error) {
            updateData.smsStatus = DeliveryStatus.FAILED;
            updateData.smsFailedReason = error instanceof Error ? error.message : 'Unknown SMS error';
            failures.push(`SMS error: ${updateData.smsFailedReason}`);
          }
          break;
        }
        case NotificationChannel.PUSH: {
          try {
            const rendered = await this.renderNotificationContent(notification, NotificationChannel.PUSH);
            const pushSent = await this.sendPushNotification(notification.recipientId, rendered.title, rendered.content);

            if (pushSent) {
              updateData.pushStatus = DeliveryStatus.DELIVERED;
              updateData.pushSentAt = now;
              updateData.pushDeliveredAt = now;
              delivered = true;
            } else {
              updateData.pushStatus = DeliveryStatus.FAILED;
              updateData.pushFailedReason = 'Push provider reported failure';
              failures.push('Push delivery failed');
            }
          } catch (error) {
            updateData.pushStatus = DeliveryStatus.FAILED;
            updateData.pushFailedReason = error instanceof Error ? error.message : 'Unknown push error';
            failures.push(`Push error: ${updateData.pushFailedReason}`);
          }
          break;
        }
        case NotificationChannel.IN_APP: {
          updateData.inAppStatus = DeliveryStatus.DELIVERED;
          updateData.inAppDisplayedAt = now;
          delivered = true;
          break;
        }
        default: {
          failures.push(`Unsupported channel ${channel}`);
          break;
        }
      }
    }

    const failureMessage = failures.join('; ');

    if (failures.length > 0) {
      updateData.lastError = failureMessage;
    } else {
      updateData.lastError = null;
    }

    if (!delivered) {
      const nextRetry = this.calculateNextRetry(notification.retryCount + 1, notification.maxRetries);
      updateData.status = nextRetry ? NotificationStatus.PENDING : NotificationStatus.FAILED;
      updateData.retryCount = notification.retryCount + 1;
      updateData.nextRetryAt = nextRetry;
    } else {
      updateData.status = NotificationStatus.DELIVERED;
      updateData.retryCount = notification.retryCount;
      updateData.nextRetryAt = null;
    }

    const updatedNotification = await prisma.notification.update({
      where: { id: notificationId },
      data: updateData
    });

    if (!delivered) {
      loggingService.log(LogLevel.WARN, LogCategory.EXTERNAL_SERVICE, 'Notification delivery incomplete', {
        notificationId,
        failures: failureMessage
      });
    }

    return updatedNotification;
  }

  private calculateNextRetry(attempt: number, maxRetries?: number | null): Date | null {
    const max = Math.max(1, maxRetries ?? 3);

    if (attempt >= max) {
      return null;
    }

    const delayMinutes = Math.pow(2, attempt) * 5;
    return new Date(Date.now() + delayMinutes * 60 * 1000);
  }

  private normalizeChannels(channels: Prisma.JsonValue | null): NotificationChannel[] {
    if (!channels) {
      return [NotificationChannel.IN_APP];
    }

    if (Array.isArray(channels)) {
      return channels
        .map(channel => (typeof channel === 'string' ? channel.toUpperCase() : channel))
        .filter(channel => Object.values(NotificationChannel).includes(channel as NotificationChannel))
        .map(channel => channel as NotificationChannel);
    }

    if (typeof channels === 'string') {
      const normalized = channels.toUpperCase();
      return Object.values(NotificationChannel).includes(normalized as NotificationChannel)
        ? [normalized as NotificationChannel]
        : [NotificationChannel.IN_APP];
    }

    if (typeof channels === 'object') {
      const values = Object.values(channels as Record<string, unknown>)
        .map(value => (typeof value === 'string' ? value.toUpperCase() : value))
        .filter(value => Object.values(NotificationChannel).includes(value as NotificationChannel))
        .map(value => value as NotificationChannel);

      if (values.length > 0) {
        return values;
      }
    }

    return [NotificationChannel.IN_APP];
  }

  private async renderNotificationContent(notification: Notification, channel?: NotificationChannel) {
    if (!notification.templateId) {
      return {
        title: notification.title,
        content: notification.message
      };
    }

    const variables = this.parseJson<Record<string, unknown>>(notification.templateVariables) ?? {};

    try {
      return await notificationTemplateService.renderTemplate(notification.templateId, variables, channel);
    } catch (error) {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Template rendering failed', {
        notificationId: notification.id,
        templateId: notification.templateId,
        channel,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        title: notification.title,
        content: notification.message
      };
    }
  }

  private parseJson<T>(value: Prisma.JsonValue | null): T | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch {
        return undefined;
      }
    }

    return value as T;
  }

  private resolveNotificationType(input?: string | NotificationType): NotificationType {
    if (!input) {
      return NotificationType.SYSTEM_MAINTENANCE;
    }

    if (typeof input !== 'string') {
      return input;
    }

    const normalized = input.toUpperCase();
    if (NOTIFICATION_TYPE_VALUES.has(normalized as NotificationType)) {
      return normalized as NotificationType;
    }

    return LEGACY_TYPE_MAP[normalized] ?? NotificationType.SYSTEM_MAINTENANCE;
  }

  private resolvePriority(priority?: string | NotificationPriority, status?: string | NotificationPriority): NotificationPriority {
    const candidate = priority ?? status;
    if (!candidate) {
      return NotificationPriority.NORMAL;
    }

    const normalized = typeof candidate === 'string' ? candidate.toUpperCase() : candidate;
    if (NOTIFICATION_PRIORITY_VALUES.has(normalized as NotificationPriority)) {
      return normalized as NotificationPriority;
    }

    return NotificationPriority.NORMAL;
  }

  private resolveChannels(channels?: (NotificationChannel | string)[]): NotificationChannel[] {
    if (!channels || channels.length === 0) {
      return [NotificationChannel.IN_APP];
    }

    const normalized = channels
      .map(channel => (typeof channel === 'string' ? channel.toUpperCase() : channel))
      .filter(channel => NOTIFICATION_CHANNEL_VALUES.has(channel as NotificationChannel))
      .map(channel => channel as NotificationChannel);

    return normalized.length > 0 ? normalized : [NotificationChannel.IN_APP];
  }

  private resolveCategory(category: string | NotificationCategory | undefined, notificationType: NotificationType): NotificationCategory {
    if (category) {
      const normalized = typeof category === 'string' ? category.toUpperCase() : category;
      if (NOTIFICATION_CATEGORY_VALUES.has(normalized as NotificationCategory)) {
        return normalized as NotificationCategory;
      }
    }

    switch (notificationType) {
      case NotificationType.APPOINTMENT_CONFIRMATION:
      case NotificationType.APPOINTMENT_REMINDER_24H:
      case NotificationType.APPOINTMENT_REMINDER_1H:
      case NotificationType.APPOINTMENT_REMINDER_15M:
      case NotificationType.APPOINTMENT_CANCELLED:
      case NotificationType.APPOINTMENT_RESCHEDULED:
      case NotificationType.CONSULTATION_STARTING:
      case NotificationType.CONSULTATION_ENDED:
        return NotificationCategory.BOOKING;
      case NotificationType.PAYMENT_AUTHORIZED:
      case NotificationType.PAYMENT_CAPTURED:
      case NotificationType.PAYMENT_FAILED:
      case NotificationType.REFUND_PROCESSED:
      case NotificationType.PAYOUT_SENT:
      case NotificationType.INVOICE_GENERATED:
        return NotificationCategory.PAYMENT;
      case NotificationType.NEW_MESSAGE:
      case NotificationType.VIDEO_CALL_INVITATION:
      case NotificationType.COMMENT_ADDED:
      case NotificationType.MENTION_IN_COMMENT:
        return NotificationCategory.COMMUNICATION;
      case NotificationType.SECURITY_ALERT:
      case NotificationType.LOGIN_ALERT:
      case NotificationType.ACCOUNT_VERIFICATION:
      case NotificationType.PASSWORD_RESET:
        return NotificationCategory.SECURITY;
      case NotificationType.DOCUMENT_SHARED:
      case NotificationType.DOCUMENT_SIGNED:
        return NotificationCategory.LEGAL;
      case NotificationType.NEWSLETTER:
      case NotificationType.PROMOTION:
        return NotificationCategory.MARKETING;
      case NotificationType.SYSTEM_MAINTENANCE:
      case NotificationType.FEATURE_ANNOUNCEMENT:
      case NotificationType.LEGAL_NOTICE:
      case NotificationType.PRIVACY_UPDATE:
      case NotificationType.TERMS_UPDATE:
        return NotificationCategory.SYSTEM;
      default:
        return NotificationCategory.UPDATE;
    }
  }

  private resolveDate(value?: Date | string): Date | undefined {
    if (!value) {
      return undefined;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}

export default new NotificationService();
