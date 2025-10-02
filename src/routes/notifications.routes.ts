import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import notificationService from '../services/notification.service';
import notificationPreferencesService from '../services/notification-preferences.service';
import notificationTemplateService from '../services/notification-template.service';
import notificationQueueService from '../services/notification-queue.service';
import firebaseService from '../services/firebase.service';
import prisma from '../config/database';
import { Prisma, NotificationType, NotificationChannel, NotificationCategory, NotificationPriority, NotificationStatus } from '@prisma/client';

const router = express.Router();

// Middleware for validation errors
const handleValidationErrors = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }
  next();
};

// Legacy Firebase routes for backward compatibility
router.post('/register-token', [
  body('fcmToken').notEmpty().withMessage('FCM token is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.headers['x-user-id'] as string; // Assuming user ID is passed in header

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const updateSuccess = await firebaseService.updateFCMToken(userId, fcmToken);

    if (!updateSuccess) {
      return res.status(500).json({
        success: false,
        message: 'Failed to register FCM token'
      });
    }

    res.json({
      success: true,
      message: 'FCM token registered successfully'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to register FCM token';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// POST /api/notifications/send - Send a notification
router.post('/send', [
  body('recipientId').notEmpty().withMessage('Recipient ID is required'),
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required'),
  body('notificationType').isString().withMessage('Notification type is required'),
  body('channels').optional().isArray().withMessage('Channels must be an array'),
  body('channels.*').optional().isString().withMessage('Channel value must be a string'),
  body('priority').optional().isIn(Object.values(NotificationPriority)).withMessage('Priority must be a valid notification priority'),
  body('status').optional().isIn(Object.values(NotificationPriority)).withMessage('Status must match a valid notification priority'),
  body('scheduledFor').optional().isISO8601().withMessage('Invalid date format')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const priorityInput = (req.body.priority ?? req.body.status ?? NotificationPriority.NORMAL) as string;
    const categoryInput = req.body.category ? String(req.body.category).toUpperCase() : undefined;

    let metadata: Record<string, unknown> | undefined;
    if (typeof req.body.metadata === 'string') {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch {
        metadata = undefined;
      }
    } else if (req.body.metadata && typeof req.body.metadata === 'object') {
      metadata = req.body.metadata as Record<string, unknown>;
    }

    let templateVariables: Record<string, unknown> | undefined;
    if (typeof req.body.templateVariables === 'string') {
      try {
        templateVariables = JSON.parse(req.body.templateVariables);
      } catch {
        templateVariables = undefined;
      }
    } else if (req.body.templateVariables && typeof req.body.templateVariables === 'object') {
      templateVariables = req.body.templateVariables as Record<string, unknown>;
    }

    const channels = Array.isArray(req.body.channels)
      ? (req.body.channels as string[])
      : undefined;

    const notificationId = await notificationService.sendNotification({
      recipientId: req.body.recipientId,
      recipientEmail: req.body.recipientEmail,
      recipientPhone: req.body.recipientPhone,
      senderId: req.body.senderId,
      senderName: req.body.senderName,
      title: req.body.title,
      message: req.body.message,
      notificationType: req.body.notificationType,
      category: categoryInput,
      priority: priorityInput,
      channels,
      templateId: req.body.templateId,
      templateVariables,
      scheduledFor: req.body.scheduledFor ? new Date(req.body.scheduledFor) : undefined,
      metadata,
      respectQuietHours: req.body.respectQuietHours,
      overridePreferences: req.body.overridePreferences,
      urgentOverride: req.body.urgentOverride,
      contextType: req.body.contextType,
      contextId: req.body.contextId
    });

    res.json({
      success: true,
      notificationId,
      message: 'Notification sent successfully'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send notification';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// GET /api/notifications/inbox/:userId - Get user's inbox
router.get('/inbox/:userId', [
  param('userId').notEmpty().withMessage('User ID is required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be non-negative'),
  query('unreadOnly').optional().isBoolean().withMessage('unreadOnly must be boolean')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const unreadOnly = req.query.unreadOnly === 'true';

    const whereClause: Prisma.NotificationWhereInput = {
      recipientId: userId,
      channels: {
        array_contains: NotificationChannel.IN_APP
      }
    };

    if (unreadOnly) {
      whereClause.isRead = false;
    }

    const notifications = await prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        title: true,
        message: true,
        notificationType: true,
        priority: true,
        inAppStatus: true,
        isRead: true,
        readAt: true,
        createdAt: true,
        metadata: true
      }
    });

    const totalCount = await prisma.notification.count({
      where: whereClause
    });

    const unreadCount = await prisma.notification.count({
      where: {
        recipientId: userId,
        channels: { array_contains: NotificationChannel.IN_APP },
        isRead: false
      }
    });

    res.json({
      success: true,
      notifications,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      },
      unreadCount
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load notifications';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// PUT /api/notifications/:notificationId/read - Mark notification as read
router.put('/:notificationId/read', [
  param('notificationId').notEmpty().withMessage('Notification ID is required'),
  body('userId').notEmpty().withMessage('User ID is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const updated = await notificationService.markInAppNotificationAsRead(
      req.params.notificationId,
      req.body.userId
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to mark notification as read';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// GET /api/notifications/preferences/:userId - Get user notification preferences
router.get('/preferences/:userId', [
  param('userId').notEmpty().withMessage('User ID is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const preferences = await notificationPreferencesService.getPreferences(req.params.userId);

    res.json({
      success: true,
      preferences
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load notification preferences';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// PUT /api/notifications/preferences/:userId - Update user notification preferences
router.put('/preferences/:userId', [
  param('userId').notEmpty().withMessage('User ID is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const preferences = await notificationPreferencesService.updatePreferences({
      userId: req.params.userId,
      ...req.body
    });

    res.json({
      success: true,
      preferences,
      message: 'Preferences updated successfully'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update notification preferences';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// POST /api/notifications/preferences/:userId/opt-out - Opt out of notification type
router.post('/preferences/:userId/opt-out', [
  param('userId').notEmpty().withMessage('User ID is required'),
  body('notificationType').isIn(Object.values(NotificationType)).withMessage('Valid notification type is required'),
  body('channel').optional().isIn(Object.values(NotificationChannel)).withMessage('Valid channel is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    await notificationPreferencesService.optOut(
      req.params.userId,
      req.body.notificationType,
      req.body.channel
    );

    res.json({
      success: true,
      message: 'Successfully opted out'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to opt out of notification type';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// GET /api/notifications/templates - Get all templates
router.get('/templates', async (req: express.Request, res: express.Response) => {
  try {
    const templates = await notificationTemplateService.getAllTemplates();

    res.json({
      success: true,
      templates
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load notification templates';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// POST /api/notifications/templates - Create new template
router.post('/templates', [
  body('name').notEmpty().withMessage('Template name is required'),
  body('notificationType').isIn(Object.values(NotificationType)).withMessage('Valid notification type is required'),
  body('category').custom(value => {
    if (!value) return false;
    const normalized = String(value).toUpperCase();
    return Object.values(NotificationCategory).includes(normalized as NotificationCategory);
  }).withMessage('Valid notification category is required'),
  body('title').notEmpty().withMessage('Title is required'),
  body('content').notEmpty().withMessage('Content is required')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const category = String(req.body.category).toUpperCase() as NotificationCategory;
    const variablesInput = req.body.variables;
    let variables: string[] | undefined;
    if (Array.isArray(variablesInput)) {
      variables = variablesInput.map(String);
    } else if (typeof variablesInput === 'string') {
      variables = variablesInput.split(',').map(item => item.trim()).filter(Boolean);
    }

    let sampleData = req.body.sampleData as unknown;
    if (typeof sampleData === 'string') {
      try {
        sampleData = JSON.parse(sampleData);
      } catch {
        sampleData = undefined;
      }
    }

    const templatePayload = {
      name: req.body.name,
      description: req.body.description,
      notificationType: req.body.notificationType as NotificationType,
      category,
      title: req.body.title,
      content: req.body.content,
      emailSubject: req.body.emailSubject,
      emailBodyHtml: req.body.emailBodyHtml,
      smsContent: req.body.smsContent,
      pushTitle: req.body.pushTitle,
      pushContent: req.body.pushContent,
      variables,
      sampleData: sampleData as Record<string, unknown> | undefined,
      isPublic: req.body.isPublic,
      requiresApproval: req.body.requiresApproval,
      version: req.body.version
    };

    const validation = await notificationTemplateService.validateTemplate(templatePayload);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Template validation failed',
        errors: validation.errors
      });
    }

    const template = await notificationTemplateService.createTemplate(templatePayload);

    res.json({
      success: true,
      template,
      message: 'Template created successfully'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create template';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// GET /api/notifications/analytics/overview - Get analytics overview
router.get('/analytics/overview', [
  query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be between 1 and 365')
], handleValidationErrors, async (req: express.Request, res: express.Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const totalNotifications = await prisma.notification.count({
      where: { createdAt: { gte: cutoffDate } }
    });

    const sentNotifications = await prisma.notification.count({
      where: {
        createdAt: { gte: cutoffDate },
        status: NotificationStatus.SENT
      }
    });

    const analytics = await prisma.notificationAnalytics.findMany({
      where: { createdAt: { gte: cutoffDate } }
    });

    const averageSuccessRate = analytics.length > 0
      ? (analytics.reduce((sum, item) => {
          if (item.totalSent && item.totalSent > 0) {
            return sum + (item.totalDelivered ?? 0) / item.totalSent;
          }
          return sum;
        }, 0) / analytics.length) * 100
      : 0;

    res.json({
      success: true,
      analytics: {
        period: `Last ${days} days`,
        totalNotifications,
        sentNotifications,
        successRate: totalNotifications > 0 ? (sentNotifications / totalNotifications) * 100 : 0,
        averageSuccessRate
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load analytics overview';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// Legacy test route for backward compatibility
router.get('/test', async (req: express.Request, res: express.Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID required in x-user-id header'
      });
    }

    const notificationId = await notificationService.sendNotification({
      recipientId: userId,
      title: '🧪 Test Notification',
      message: 'Your comprehensive notification system is working!',
      notificationType: NotificationType.SYSTEM_MAINTENANCE,
      priority: NotificationPriority.NORMAL,
      channels: ['IN_APP', 'PUSH'],
      metadata: { type: 'test', timestamp: new Date().toISOString() }
    });

    res.json({
      success: true,
      message: 'Test notification sent using comprehensive system',
      notificationId,
      userId,
      timestamp: new Date()
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send test notification';
    res.status(500).json({
      success: false,
      message
    });
  }
});

// Legacy status route for backward compatibility
router.get('/status', async (req: express.Request, res: express.Response) => {
  try {
    const firebaseAvailable = firebaseService.isAvailable();
    const queueStats = await notificationQueueService.getQueueStats();

    res.json({
      success: true,
      data: {
        comprehensiveNotificationSystem: 'active',
        firebaseAdminSDK: firebaseAvailable ? 'available' : 'not configured',
        emailService: 'configured',
        smsService: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
        queueProcessor: 'active',
        queueStats,
        timestamp: new Date()
      }
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get notification status';
    res.status(500).json({
      success: false,
      error: message
    });
  }
});

export default router;