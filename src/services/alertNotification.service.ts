import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  Prisma,
  SystemAlerts,
  UserRole
} from '@prisma/client';
import prismaClient from '../config/database';
import notificationService from './notification.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';

interface AlertMetadata {
  lawyerId?: string;
  snapshot?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Recipient {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
}

class AlertNotificationService {
  constructor(private readonly prisma = prismaClient) {}

  async notifyNewSystemAlert(alert: SystemAlerts): Promise<void> {
    try {
      const recipients = await this.resolveRecipients();

      if (recipients.length === 0) {
        loggingService.log(
          LogLevel.WARN,
          LogCategory.SYSTEM,
          'No admin recipients found for system alert notification',
          { alertId: alert.id, alertName: alert.alertName }
        );
        return;
      }

      const metadata = this.parseMetadata(alert.alertMetadata);
      const message = this.buildMessage(alert, metadata);
      const priority = this.mapPriority(alert.severity);

      const sendResults = await Promise.allSettled(
        recipients.map((recipient) => {
          const channels = recipient.email
            ? [NotificationChannel.IN_APP, NotificationChannel.EMAIL]
            : [NotificationChannel.IN_APP];

          return notificationService.sendNotification({
            recipientId: recipient.id,
            recipientEmail: recipient.email ?? undefined,
            recipientName: this.formatName(recipient.firstName, recipient.lastName),
            title: `${this.capitalize(alert.severity || 'alert')} alert: ${alert.title}`,
            message,
            notificationType: NotificationType.SECURITY_ALERT,
            category: NotificationCategory.ALERT,
            priority,
            channels,
            metadata: {
              alertId: alert.id,
              severity: alert.severity,
              component: alert.component,
              metricName: alert.metricName,
              lawyerId: metadata?.lawyerId ?? null
            },
            contextType: 'system_alert',
            contextId: alert.id,
            overridePreferences: true,
            urgentOverride: priority === NotificationPriority.CRITICAL
          });
        })
      );

      sendResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          loggingService.log(
            LogLevel.ERROR,
            LogCategory.SYSTEM,
            'Failed to dispatch system alert notification',
            {
              alertId: alert.id,
              alertName: alert.alertName,
              recipientId: recipients[index]?.id,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason)
            }
          );
        }
      });
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'alertNotification.notifyNewSystemAlert',
        alertId: alert.id,
        alertName: alert.alertName
      });
    }
  }

  private async resolveRecipients(): Promise<Recipient[]> {
    try {
      const admins = await this.prisma.user.findMany({
        where: {
          role: UserRole.ADMIN,
          isVerified: true
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true
        },
        take: 20
      });

      return admins;
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'alertNotification.resolveRecipients'
      });
      return [];
    }
  }

  private parseMetadata(metadata: Prisma.JsonValue | null): AlertMetadata | null {
    if (!metadata) {
      return null;
    }

    if (typeof metadata === 'object') {
      return metadata as AlertMetadata;
    }

    try {
      if (typeof metadata === 'string') {
        return JSON.parse(metadata) as AlertMetadata;
      }
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'alertNotification.parseMetadata',
        metadata
      });
    }

    return null;
  }

  private buildMessage(alert: SystemAlerts, metadata: AlertMetadata | null): string {
    const threshold = alert.threshold ? alert.threshold.toString() : 'n/a';
    const actual = alert.actualValue ? alert.actualValue.toString() : 'n/a';

    const lines = [alert.description];

    lines.push('');
    lines.push(`Severity: ${this.capitalize(alert.severity || 'unknown')}`);
    lines.push(`Metric: ${alert.metricName ?? 'n/a'}`);
    lines.push(`Threshold: ${threshold}`);
    lines.push(`Observed: ${actual}`);

    if (metadata?.lawyerId) {
      lines.push(`Lawyer ID: ${metadata.lawyerId}`);
    }

    if (metadata?.snapshot && typeof metadata.snapshot === 'object') {
      const snapshot = metadata.snapshot;
      if (typeof snapshot.averageRating === 'number') {
        lines.push(`Average rating: ${snapshot.averageRating.toFixed(2)}`);
      }
      if (typeof snapshot.reviewCount === 'number') {
        lines.push(`Review count: ${snapshot.reviewCount}`);
      }
    }

    lines.push('');
    lines.push('Please review the alert dashboard for details and remediation guidance.');

    return lines.join('\n');
  }

  private mapPriority(severity?: string | null): NotificationPriority {
    switch ((severity || '').toLowerCase()) {
      case 'critical':
        return NotificationPriority.CRITICAL;
      case 'warning':
        return NotificationPriority.HIGH;
      case 'info':
        return NotificationPriority.NORMAL;
      default:
        return NotificationPriority.HIGH;
    }
  }

  private capitalize(value: string): string {
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }

  private formatName(first: string, last: string): string {
    return [first, last].filter(Boolean).join(' ').trim();
  }
}

export default new AlertNotificationService();
