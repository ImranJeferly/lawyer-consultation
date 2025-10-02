import axios from 'axios';
import crypto from 'crypto';
import prisma from '../config/database';
import { Notification, NotificationWebhook, NotificationType } from '@prisma/client';
import loggingService, { LogCategory, LogLevel } from './logging.service';

interface WebhookPayload {
  notification: Record<string, unknown>;
  deliveredAt: string;
}

class NotificationWebhookService {
  async triggerForNotification(notification: Notification): Promise<void> {
    const eventKey = notification.notificationType as NotificationType;
    const payload: WebhookPayload = {
      notification: this.serializeNotification(notification),
      deliveredAt: new Date().toISOString()
    };

    const webhooks = await prisma.notificationWebhook.findMany({
      where: {
        isActive: true
      }
    });

    await Promise.all(
      webhooks.map(async (webhook) => {
        const events = this.parseEvents(webhook);
        if (!this.shouldTrigger(events, eventKey)) {
          return;
        }

        const body = JSON.stringify(payload);
        const signature = this.createSignature(body, webhook.secret);

        try {
          await axios.post(webhook.url, payload, {
            headers: {
              'Content-Type': 'application/json',
              'X-Notification-Event': eventKey,
              'X-Notification-Signature': signature,
              ...(webhook.authHeader ? { Authorization: webhook.authHeader } : {})
            },
            timeout: 10_000
          });

          await prisma.notificationWebhook.update({
            where: { id: webhook.id },
            data: {
              lastTriggered: new Date(),
              successCount: webhook.successCount + 1
            }
          });
        } catch (error) {
          loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Notification webhook delivery failed', {
            webhookId: webhook.id,
            url: webhook.url,
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          await prisma.notificationWebhook.update({
            where: { id: webhook.id },
            data: {
              lastTriggered: new Date(),
              failureCount: webhook.failureCount + 1
            }
          });
        }
      })
    );
  }

  private parseEvents(webhook: NotificationWebhook): string[] {
    try {
      const events = webhook.events as unknown;
      if (Array.isArray(events)) {
        return events.map(String);
      }

      if (typeof events === 'string') {
        const parsed = JSON.parse(events);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      }

      if (events && typeof events === 'object') {
        return Object.values(events).map(String);
      }
    } catch (error) {
      loggingService.log(LogLevel.WARN, LogCategory.EXTERNAL_SERVICE, 'Failed to parse webhook events', {
        webhookId: webhook.id,
        error: error instanceof Error ? error.message : 'Unknown'
      });
    }

    return [];
  }

  private serializeNotification(notification: Notification): Record<string, unknown> {
    return JSON.parse(JSON.stringify(notification)) as Record<string, unknown>;
  }

  private shouldTrigger(events: string[], eventKey: string): boolean {
    if (events.length === 0) {
      return true;
    }

    const normalized = eventKey.toUpperCase();
    const prepared = events.map(event => event.toUpperCase());

    return prepared.includes('*') || prepared.includes(normalized);
  }

  private createSignature(body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
}

export default new NotificationWebhookService();
