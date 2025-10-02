import prisma from '../config/database';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationType,
  Prisma
} from '@prisma/client';

interface CreateTemplateInput {
  name: string;
  description?: string;
  notificationType: NotificationType;
  category: NotificationCategory;
  title: string;
  content: string;
  emailSubject?: string;
  emailBodyHtml?: string;
  smsContent?: string;
  pushTitle?: string;
  pushContent?: string;
  variables?: string[];
  sampleData?: Record<string, unknown>;
  isPublic?: boolean;
  requiresApproval?: boolean;
  version?: string;
}

interface ValidateTemplateResult {
  isValid: boolean;
  errors: string[];
}

interface RenderedTemplate {
  channel: NotificationChannel | 'DEFAULT';
  title: string;
  content: string;
}

class NotificationTemplateService {
  async getAllTemplates() {
    return prisma.notificationTemplate.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }]
    });
  }

  async createTemplate(input: CreateTemplateInput) {
    const validation = await this.validateTemplate(input);
    if (!validation.isValid) {
      throw new Error(`Template validation failed: ${validation.errors.join(', ')}`);
    }

    const templateKey = this.generateTemplateKey(input.name, input.notificationType);

    return prisma.notificationTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        templateKey,
        notificationType: input.notificationType,
        category: input.category,
        emailSubject: input.emailSubject ?? input.title,
        emailBodyText: input.content,
        emailBodyHtml: input.emailBodyHtml ?? input.content,
        smsContent: input.smsContent,
        pushTitle: input.pushTitle ?? input.title,
        pushBody: input.pushContent ?? input.content,
        inAppTitle: input.title,
        inAppMessage: input.content,
        variables: this.serializeJson(input.variables ?? []),
        sampleData: input.sampleData ? this.serializeJson(input.sampleData) : undefined,
        conditions: this.serializeJson({}),
        isActive: true,
        isPublic: input.isPublic ?? false,
        requiresApproval: input.requiresApproval ?? false,
        version: input.version ?? '1.0'
      }
    });
  }

  async validateTemplate(input: Partial<CreateTemplateInput>): Promise<ValidateTemplateResult> {
    const errors: string[] = [];

    if (!input.name?.trim()) errors.push('Name is required');
    if (!input.notificationType) errors.push('Notification type is required');
    if (!input.category) errors.push('Category is required');
    if (!input.title?.trim()) errors.push('Title is required');
    if (!input.content?.trim()) errors.push('Content is required');

    if (input.notificationType && !Object.values(NotificationType).includes(input.notificationType)) {
      errors.push('Invalid notification type');
    }

    if (input.category && !Object.values(NotificationCategory).includes(input.category)) {
      errors.push('Invalid notification category');
    }

    const aggregatedContent = [
      input.title,
      input.content,
      input.emailSubject,
      input.emailBodyHtml,
      input.smsContent,
      input.pushTitle,
      input.pushContent
    ]
      .filter(Boolean)
      .join(' ');

    const invalidVariables = this.extractInvalidVariables(aggregatedContent);
    if (invalidVariables.length > 0) {
      errors.push(`Invalid variable syntax: ${invalidVariables.join(', ')}`);
    }

    return { isValid: errors.length === 0, errors };
  }

  async renderTemplate(templateId: string, variables: Record<string, unknown>, channel?: NotificationChannel): Promise<RenderedTemplate> {
    const template = await prisma.notificationTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      throw new Error('Template not found');
    }

    const baseRender = {
      title: this.applyVariables(template.inAppTitle ?? template.name, variables),
      content: this.applyVariables(template.inAppMessage ?? template.emailBodyText ?? '', variables)
    };

    if (!channel) {
      return { channel: 'DEFAULT', ...baseRender };
    }

    switch (channel) {
      case NotificationChannel.EMAIL:
        return {
          channel,
          title: this.applyVariables(template.emailSubject ?? baseRender.title, variables),
          content: this.applyVariables(template.emailBodyHtml ?? template.emailBodyText ?? baseRender.content, variables)
        };
      case NotificationChannel.SMS:
        return {
          channel,
          title: baseRender.title,
          content: this.applyVariables(template.smsContent ?? baseRender.content, variables)
        };
      case NotificationChannel.PUSH:
        return {
          channel,
          title: this.applyVariables(template.pushTitle ?? baseRender.title, variables),
          content: this.applyVariables(template.pushBody ?? baseRender.content, variables)
        };
      case NotificationChannel.IN_APP:
        return { channel, ...baseRender };
      default:
        return { channel, ...baseRender };
    }
  }

  private generateTemplateKey(name: string, type: NotificationType): string {
    const normalizedName = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${type.toLowerCase()}-${normalizedName}`;
  }

  private serializeJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private extractInvalidVariables(content: string): string[] {
    if (!content) return [];

    const matches = content.match(/{{.*?}}/g) ?? [];
    return matches.filter(match => !/^{{[\w\s#\/\.@-]+}}$/.test(match));
  }

  private applyVariables(text: string, variables: Record<string, unknown>): string {
    let result = text;

    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      result = result.replace(regex, String(value ?? ''));
    });

    result = result.replace(/{{#if\s+(\w+)}}([\s\S]*?){{\/if}}/g, (match, variableName, content) => {
      const value = variables[variableName];
      return value ? content : '';
    });

    result = result.replace(/{{#unless\s+(\w+)}}([\s\S]*?){{\/unless}}/g, (match, variableName, content) => {
      const value = variables[variableName];
      return value ? '' : content;
    });

    return result;
  }
}

export default new NotificationTemplateService();
