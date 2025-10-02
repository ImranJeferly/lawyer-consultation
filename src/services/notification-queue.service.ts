import { Queue, Worker, JobsOptions, Job } from 'bullmq';
import { QueueStatus, NotificationStatus } from '@prisma/client';
import { getRedisConnection } from '../config/redis';
import prisma from '../config/database';
import notificationService from './notification.service';
import notificationWebhookService from './notification-webhook.service';
import loggingService, { LogCategory, LogLevel } from './logging.service';

const QUEUE_NAME = 'notification-delivery';

interface QueueJobData {
  notificationId: string;
}

class NotificationQueueService {
  private queue?: Queue<QueueJobData>;
  private worker?: Worker<QueueJobData, void>;
  private initialized = false;

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const connection = getRedisConnection();

    this.queue = new Queue<QueueJobData>(QUEUE_NAME, {
      connection,
      defaultJobOptions: this.getDefaultJobOptions()
    });
    await this.queue.waitUntilReady();

    const concurrency = Number(process.env.NOTIFICATION_WORKER_CONCURRENCY ?? 5);

    this.worker = new Worker<QueueJobData>(
      QUEUE_NAME,
      async (job: Job<QueueJobData>) => this.handleJob(job),
      {
        connection,
        concurrency
      }
    );

    this.worker.on('failed', (job: Job<QueueJobData> | undefined, error: Error) => {
      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Notification job failed', {
        jobId: job?.id,
        notificationId: job?.data.notificationId,
        error: error?.message
      });
    });

    this.worker.on('completed', (job: Job<QueueJobData>) => {
      loggingService.log(LogLevel.DEBUG, LogCategory.SYSTEM, 'Notification job completed', {
        jobId: job.id,
        notificationId: job.data.notificationId
      });
    });

    this.initialized = true;
    loggingService.log(LogLevel.INFO, LogCategory.SYSTEM, 'Notification queue initialized');
  }

  public async enqueueNotification(notificationId: string, scheduledFor?: Date | null): Promise<void> {
    await this.initialize();

    const queue = this.queue;
    if (!queue) {
      throw new Error('Notification queue not initialized');
    }

    const targetDate = scheduledFor ?? new Date();
    const delayMs = Math.max(0, targetDate.getTime() - Date.now());

    await prisma.notificationQueue.upsert({
      where: { notificationId },
      update: {
        status: QueueStatus.QUEUED,
        nextAttempt: targetDate,
        errorMessage: null,
        processedAt: null
      },
      create: {
        notificationId,
        queueName: QUEUE_NAME,
        nextAttempt: targetDate,
        status: QueueStatus.QUEUED
      }
    });

    await queue.add(
      'deliver-notification',
      { notificationId },
      {
        delay: delayMs,
        priority: this.resolvePriority(targetDate)
      }
    );
  }

  public async cancelNotification(notificationId: string): Promise<void> {
    await this.initialize();
    const queue = this.queue;
    if (!queue) return;

    const jobs: Job<QueueJobData>[] = await queue.getJobs(['delayed', 'waiting']);
    await Promise.all(
      jobs
        .filter((job: Job<QueueJobData>) => job.data.notificationId === notificationId)
        .map((job: Job<QueueJobData>) => job.remove())
    );

    await prisma.notificationQueue.updateMany({
      where: { notificationId },
      data: {
        status: QueueStatus.CANCELLED,
        errorMessage: 'Cancelled by user',
        processedAt: new Date()
      }
    });
  }

  public async getQueueStats() {
    await this.initialize();

    const [grouped, waitingCount, delayedCount] = await Promise.all([
      prisma.notificationQueue.groupBy({
        by: ['status'],
        _count: { id: true }
      }),
      this.queue?.getWaitingCount() ?? 0,
      this.queue?.getDelayedCount() ?? 0
    ]);

    const stats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      waiting: waitingCount,
      delayed: delayedCount
    };

    grouped.forEach((group: { status: QueueStatus; _count: { id: number } }) => {
      stats[group.status.toLowerCase() as keyof typeof stats] = group._count.id;
    });

    return stats;
  }

  private getDefaultJobOptions(): JobsOptions {
    const attempts = Number(process.env.NOTIFICATION_QUEUE_ATTEMPTS ?? 5);
    const backoffDelay = Number(process.env.NOTIFICATION_QUEUE_BACKOFF_MS ?? 30000);

    return {
      attempts,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      backoff: {
        type: 'exponential',
        delay: backoffDelay
      }
    };
  }

  private resolvePriority(scheduledFor: Date): number {
    const diffMinutes = (scheduledFor.getTime() - Date.now()) / 60000;
    if (diffMinutes <= 5) return 1;
    if (diffMinutes <= 30) return 3;
    if (diffMinutes <= 120) return 5;
    return 8;
  }

  private async handleJob(job: Job<QueueJobData>): Promise<void> {
    const { notificationId } = job.data;

    const queueEntry = await prisma.notificationQueue.update({
      where: { notificationId },
      data: {
        status: QueueStatus.PROCESSING,
        attempts: { increment: 1 },
        errorMessage: null
      }
    });

    try {
      const notification = await notificationService.deliverNotification(notificationId);
      await notificationWebhookService.triggerForNotification(notification);

      if (notification.status === NotificationStatus.PENDING && notification.nextRetryAt) {
        await prisma.notificationQueue.update({
          where: { id: queueEntry.id },
          data: {
            status: QueueStatus.QUEUED,
            nextAttempt: notification.nextRetryAt,
            errorMessage: notification.lastError ?? null,
            processedAt: null
          }
        });

        await this.enqueueNotification(notification.id, notification.nextRetryAt);
      } else {
        await prisma.notificationQueue.update({
          where: { id: queueEntry.id },
          data: {
            status: QueueStatus.COMPLETED,
            processedAt: new Date(),
            errorMessage: null
          }
        });
      }
    } catch (error) {
      await prisma.notificationQueue.update({
        where: { id: queueEntry.id },
        data: {
          status: QueueStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      loggingService.log(LogLevel.ERROR, LogCategory.EXTERNAL_SERVICE, 'Notification delivery failed', {
        notificationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw error;
    }
  }
}

export default new NotificationQueueService();