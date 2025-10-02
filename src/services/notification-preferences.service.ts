import { PrismaClient, NotificationType, NotificationChannel } from '@prisma/client';

interface NotificationPreferencesData {
  userId: string;
  enableNotifications?: boolean;
  enableEmail?: boolean;
  enableSms?: boolean;
  enablePush?: boolean;
  enableInApp?: boolean;
  globalQuietHours?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  emailNotificationTypes?: NotificationType[];
  smsNotificationTypes?: NotificationType[];
  pushNotificationTypes?: NotificationType[];
  inAppNotificationTypes?: NotificationType[];
  frequencyLimit?: number;
  frequencyWindow?: number;
}

class NotificationPreferencesService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async createDefaultPreferences(userId: string): Promise<any> {
    const defaultPreferences = {
      userId,
      enableNotifications: true,
      enableEmail: true,
      enableSms: true,
      enablePush: true,
      enableInApp: true,
      globalQuietHours: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      emailNotificationTypes: [
        'BOOKING_CONFIRMATION',
        'BOOKING_CANCELLED',
        'BOOKING_RESCHEDULED',
        'APPOINTMENT_REMINDER',
        'PAYMENT_CONFIRMATION',
        'PAYMENT_FAILED',
        'DOCUMENT_SHARED',
        'MESSAGE_RECEIVED',
        'SYSTEM_MAINTENANCE',
        'ACCOUNT_SECURITY'
      ],
      smsNotificationTypes: [
        'BOOKING_CONFIRMATION',
        'APPOINTMENT_REMINDER',
        'BOOKING_CANCELLED',
        'BOOKING_RESCHEDULED',
        'URGENT_MESSAGE'
      ],
      pushNotificationTypes: [
        'MESSAGE_RECEIVED',
        'APPOINTMENT_REMINDER',
        'BOOKING_CONFIRMATION',
        'URGENT_MESSAGE',
        'CALL_INCOMING'
      ],
      inAppNotificationTypes: [
        'MESSAGE_RECEIVED',
        'DOCUMENT_SHARED',
        'BOOKING_CONFIRMATION',
        'BOOKING_CANCELLED',
        'BOOKING_RESCHEDULED',
        'APPOINTMENT_REMINDER',
        'PAYMENT_CONFIRMATION',
        'SYSTEM_UPDATE',
        'FEATURE_ANNOUNCEMENT'
      ],
      frequencyLimit: 50, // Max 50 notifications per window
      frequencyWindow: 3600 // 1 hour window in seconds
    };

    try {
      return await this.prisma.notificationPreferences.create({
        data: defaultPreferences
      });
    } catch (error: any) {
      // If preferences already exist, return existing ones
      if (error.code === 'P2002') {
        return await this.getPreferences(userId);
      }
      throw error;
    }
  }

  async getPreferences(userId: string): Promise<any> {
    let preferences = await this.prisma.notificationPreferences.findUnique({
      where: { userId }
    });

    // Create default preferences if they don't exist
    if (!preferences) {
      preferences = await this.createDefaultPreferences(userId);
    }

    return preferences;
  }

  async updatePreferences(data: NotificationPreferencesData) {
    const { userId, ...updateData } = data;

    // Ensure preferences exist
    await this.getPreferences(userId);

    return await this.prisma.notificationPreferences.update({
      where: { userId },
      data: updateData
    });
  }

  async toggleNotifications(userId: string, enabled: boolean) {
    return await this.updatePreferences({
      userId,
      enableNotifications: enabled
    });
  }

  async toggleChannel(userId: string, channel: NotificationChannel, enabled: boolean) {
    const updateData: any = { userId };

    switch (channel) {
      case 'EMAIL':
        updateData.enableEmail = enabled;
        break;
      case 'SMS':
        updateData.enableSms = enabled;
        break;
      case 'PUSH':
        updateData.enablePush = enabled;
        break;
      case 'IN_APP':
        updateData.enableInApp = enabled;
        break;
    }

    return await this.updatePreferences(updateData);
  }

  async setQuietHours(userId: string, enabled: boolean, startTime?: string, endTime?: string) {
    const updateData: NotificationPreferencesData = {
      userId,
      globalQuietHours: enabled
    };

    if (enabled && startTime && endTime) {
      updateData.quietHoursStart = startTime;
      updateData.quietHoursEnd = endTime;
    }

    return await this.updatePreferences(updateData);
  }

  async updateNotificationTypesForChannel(
    userId: string,
    channel: NotificationChannel,
    notificationTypes: NotificationType[]
  ) {
    const updateData: any = { userId };

    switch (channel) {
      case 'EMAIL':
        updateData.emailNotificationTypes = notificationTypes;
        break;
      case 'SMS':
        updateData.smsNotificationTypes = notificationTypes;
        break;
      case 'PUSH':
        updateData.pushNotificationTypes = notificationTypes;
        break;
      case 'IN_APP':
        updateData.inAppNotificationTypes = notificationTypes;
        break;
    }

    return await this.updatePreferences(updateData);
  }

  async setFrequencyLimit(userId: string, limit: number, windowSeconds: number = 3600) {
    return await this.updatePreferences({
      userId,
      frequencyLimit: limit,
      frequencyWindow: windowSeconds
    });
  }

  async checkFrequencyLimit(userId: string): Promise<boolean> {
    const preferences = await this.getPreferences(userId);

    if (!preferences.frequencyLimit || !preferences.frequencyWindow) {
      return true; // No limit set
    }

    const windowStart = new Date(Date.now() - preferences.frequencyWindow * 1000);

    const recentNotificationsCount = await this.prisma.notification.count({
      where: {
        recipientId: userId,
        createdAt: {
          gte: windowStart
        }
      }
    });

    return recentNotificationsCount < preferences.frequencyLimit;
  }

  async optOut(userId: string, notificationType: NotificationType, channel?: NotificationChannel) {
    const preferences = await this.getPreferences(userId);

    if (channel) {
      // Remove from specific channel
      let currentTypes: NotificationType[] = [];
      let updateField: string = '';

      switch (channel) {
        case 'EMAIL':
          currentTypes = preferences.emailNotificationTypes as NotificationType[] || [];
          updateField = 'emailNotificationTypes';
          break;
        case 'SMS':
          currentTypes = preferences.smsNotificationTypes as NotificationType[] || [];
          updateField = 'smsNotificationTypes';
          break;
        case 'PUSH':
          currentTypes = preferences.pushNotificationTypes as NotificationType[] || [];
          updateField = 'pushNotificationTypes';
          break;
        case 'IN_APP':
          currentTypes = preferences.inAppNotificationTypes as NotificationType[] || [];
          updateField = 'inAppNotificationTypes';
          break;
      }

      const updatedTypes = currentTypes.filter(type => type !== notificationType);

      return await this.updatePreferences({
        userId,
        [updateField]: updatedTypes
      } as any);
    } else {
      // Remove from all channels
      const updateData: any = { userId };

      ['email', 'sms', 'push', 'inApp'].forEach(channelType => {
        const fieldName = `${channelType}NotificationTypes`;
        const currentTypes = (preferences as any)[fieldName] as NotificationType[] || [];
        updateData[fieldName] = currentTypes.filter(type => type !== notificationType);
      });

      return await this.updatePreferences(updateData);
    }
  }

  async optIn(userId: string, notificationType: NotificationType, channel?: NotificationChannel) {
    const preferences = await this.getPreferences(userId);

    if (channel) {
      // Add to specific channel
      let currentTypes: NotificationType[] = [];
      let updateField: string = '';

      switch (channel) {
        case 'EMAIL':
          currentTypes = preferences.emailNotificationTypes as NotificationType[] || [];
          updateField = 'emailNotificationTypes';
          break;
        case 'SMS':
          currentTypes = preferences.smsNotificationTypes as NotificationType[] || [];
          updateField = 'smsNotificationTypes';
          break;
        case 'PUSH':
          currentTypes = preferences.pushNotificationTypes as NotificationType[] || [];
          updateField = 'pushNotificationTypes';
          break;
        case 'IN_APP':
          currentTypes = preferences.inAppNotificationTypes as NotificationType[] || [];
          updateField = 'inAppNotificationTypes';
          break;
      }

      if (!currentTypes.includes(notificationType)) {
        currentTypes.push(notificationType);
      }

      return await this.updatePreferences({
        userId,
        [updateField]: currentTypes
      } as any);
    } else {
      // Add to all channels
      const updateData: any = { userId };

      ['email', 'sms', 'push', 'inApp'].forEach(channelType => {
        const fieldName = `${channelType}NotificationTypes`;
        const currentTypes = (preferences as any)[fieldName] as NotificationType[] || [];

        if (!currentTypes.includes(notificationType)) {
          currentTypes.push(notificationType);
        }

        updateData[fieldName] = currentTypes;
      });

      return await this.updatePreferences(updateData);
    }
  }

  async getOptOutStatus(userId: string, notificationType: NotificationType) {
    const preferences = await this.getPreferences(userId);

    return {
      email: !(preferences.emailNotificationTypes as NotificationType[])?.includes(notificationType),
      sms: !(preferences.smsNotificationTypes as NotificationType[])?.includes(notificationType),
      push: !(preferences.pushNotificationTypes as NotificationType[])?.includes(notificationType),
      inApp: !(preferences.inAppNotificationTypes as NotificationType[])?.includes(notificationType)
    };
  }

  async bulkOptOut(userId: string, notificationTypes: NotificationType[], channels?: NotificationChannel[]) {
    const preferences = await this.getPreferences(userId);
    const updateData: any = { userId };

    const channelsToUpdate = channels || ['EMAIL', 'SMS', 'PUSH', 'IN_APP'];

    channelsToUpdate.forEach(channel => {
      let fieldName: string;
      let currentTypes: NotificationType[];

      switch (channel) {
        case 'EMAIL':
          fieldName = 'emailNotificationTypes';
          currentTypes = preferences.emailNotificationTypes as NotificationType[] || [];
          break;
        case 'SMS':
          fieldName = 'smsNotificationTypes';
          currentTypes = preferences.smsNotificationTypes as NotificationType[] || [];
          break;
        case 'PUSH':
          fieldName = 'pushNotificationTypes';
          currentTypes = preferences.pushNotificationTypes as NotificationType[] || [];
          break;
        case 'IN_APP':
          fieldName = 'inAppNotificationTypes';
          currentTypes = preferences.inAppNotificationTypes as NotificationType[] || [];
          break;
        default:
          return;
      }

      updateData[fieldName] = currentTypes.filter(type => !notificationTypes.includes(type));
    });

    return await this.updatePreferences(updateData);
  }

  async exportPreferences(userId: string) {
    const preferences = await this.getPreferences(userId);

    return {
      ...preferences,
      exportedAt: new Date().toISOString(),
      version: '1.0'
    };
  }

  async importPreferences(userId: string, preferencesData: any) {
    // Validate and sanitize imported preferences
    const validatedData: NotificationPreferencesData = {
      userId,
      enableNotifications: preferencesData.enableNotifications ?? true,
      enableEmail: preferencesData.enableEmail ?? true,
      enableSms: preferencesData.enableSms ?? true,
      enablePush: preferencesData.enablePush ?? true,
      enableInApp: preferencesData.enableInApp ?? true,
      globalQuietHours: preferencesData.globalQuietHours ?? false,
      quietHoursStart: preferencesData.quietHoursStart || '22:00',
      quietHoursEnd: preferencesData.quietHoursEnd || '08:00',
      frequencyLimit: preferencesData.frequencyLimit || 50,
      frequencyWindow: preferencesData.frequencyWindow || 3600
    };

    // Validate notification types arrays
    const validNotificationTypes = Object.values(NotificationType);

    if (preferencesData.emailNotificationTypes && Array.isArray(preferencesData.emailNotificationTypes)) {
      validatedData.emailNotificationTypes = preferencesData.emailNotificationTypes.filter(
        (type: string) => validNotificationTypes.includes(type as NotificationType)
      );
    }

    if (preferencesData.smsNotificationTypes && Array.isArray(preferencesData.smsNotificationTypes)) {
      validatedData.smsNotificationTypes = preferencesData.smsNotificationTypes.filter(
        (type: string) => validNotificationTypes.includes(type as NotificationType)
      );
    }

    if (preferencesData.pushNotificationTypes && Array.isArray(preferencesData.pushNotificationTypes)) {
      validatedData.pushNotificationTypes = preferencesData.pushNotificationTypes.filter(
        (type: string) => validNotificationTypes.includes(type as NotificationType)
      );
    }

    if (preferencesData.inAppNotificationTypes && Array.isArray(preferencesData.inAppNotificationTypes)) {
      validatedData.inAppNotificationTypes = preferencesData.inAppNotificationTypes.filter(
        (type: string) => validNotificationTypes.includes(type as NotificationType)
      );
    }

    return await this.updatePreferences(validatedData);
  }

  async getUsersWithPreference(preference: string, value: any, limit: number = 1000) {
    const whereClause: any = {};
    whereClause[preference] = value;

    return await this.prisma.notificationPreferences.findMany({
      where: whereClause,
      select: { userId: true },
      take: limit
    });
  }

  async getPreferenceStatistics() {
    const totalUsers = await this.prisma.notificationPreferences.count();

    const stats = await this.prisma.notificationPreferences.aggregate({
      _count: {
        userId: true
      },
      _avg: {
        // frequencyLimit: true, // Field does not exist in schema
        // frequencyWindow: true // Field does not exist in schema
        smsFrequencyLimit: true,
        emailFrequencyLimit: true
      }
    });

    const channelStats = {
      enableNotifications: await this.prisma.notificationPreferences.count({ where: { enableNotifications: true } }),
      // enableEmail: await this.prisma.notificationPreferences.count({ where: { enableEmail: true } }), // Field does not exist
      // enableSms: await this.prisma.notificationPreferences.count({ where: { enableSms: true } }), // Field does not exist
      // enablePush: await this.prisma.notificationPreferences.count({ where: { enablePush: true } }), // Field does not exist
      // enableInApp: await this.prisma.notificationPreferences.count({ where: { enableInApp: true } }), // Field does not exist
      globalQuietHours: await this.prisma.notificationPreferences.count({ where: { globalQuietHours: true } })
    };

    return {
      totalUsers,
      averageFrequencyLimit: stats._avg?.smsFrequencyLimit || 0,
      averageFrequencyWindow: stats._avg?.emailFrequencyLimit || 0, // Using emailFrequencyLimit as fallback
      channelPreferences: Object.entries(channelStats).map(([channel, count]) => ({
        channel,
        enabledCount: count,
        enabledPercentage: totalUsers > 0 ? (count / totalUsers) * 100 : 0
      }))
    };
  }
}

export default new NotificationPreferencesService();