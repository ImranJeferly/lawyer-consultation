import { DocumentTemplate, GeneratedDocument, TemplateCategory, DocumentCategory, SecurityLevel, TemplateStatus, Prisma } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import prisma from '../config/database';
import documentService from './document.service';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);
const accessAsync = promisify(fs.access);

type TemplateVariableType = 'text' | 'number' | 'date' | 'boolean';

interface TemplateVariableDefinition {
  name: string;
  label?: string;
  type: TemplateVariableType;
  required?: boolean;
  defaultValue?: unknown;
  options?: string[];
}

interface CreateTemplateOptions {
  name: string;
  description?: string;
  category: TemplateCategory;
  practiceArea?: string;
  templateContent?: string;
  content?: string;
  templateVariables?: TemplateVariableDefinition[];
  variables?: TemplateVariableDefinition[];
  sampleData?: Record<string, unknown>;
  isPublic?: boolean;
  isPremium?: boolean;
  createdBy: string;
}

interface ListTemplatesFilters {
  category?: TemplateCategory;
  practiceArea?: string;
  isPublic?: boolean;
  search?: string;
}

interface PaginationOptions {
  limit?: number;
  offset?: number;
}

interface GenerateDocumentOptions {
  templateId: string;
  userId: string;
  variables: Record<string, unknown>;
  format?: 'html' | 'pdf';
  folderId?: string;
  fileName?: string;
}

interface TemplateValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

interface TemplateValidationResult {
  isValid: boolean;
  issues: TemplateValidationIssue[];
}

class DocumentTemplatesService {
  private helpersRegistered = false;

  async createTemplate(options: CreateTemplateOptions): Promise<DocumentTemplate | null> {
    try {
      const templateContent = (options.templateContent ?? options.content ?? '').trim();
      if (!templateContent) {
        throw new Error('Template content is required');
      }

      const variableDefinitions = this.parseVariableDefinitions(options.templateVariables ?? options.variables ?? []);
      const validation = this.validateTemplateDefinition(templateContent, variableDefinitions);

      if (!validation.isValid) {
        const errors = validation.issues
          .filter(issue => issue.severity === 'error')
          .map(issue => issue.message)
          .join(', ');
        throw new Error(`Template validation failed: ${errors}`);
      }

      try {
        Handlebars.compile(templateContent);
      } catch (error) {
        throw new Error(`Template compilation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      const template = await prisma.documentTemplate.create({
        data: {
          name: options.name,
          description: options.description,
          category: options.category,
          practiceArea: options.practiceArea,
          templateContent,
          templateVariables: JSON.parse(JSON.stringify(variableDefinitions)) as Prisma.InputJsonValue,
          sampleData: JSON.parse(JSON.stringify(options.sampleData ?? {})) as Prisma.InputJsonValue,
          isPublic: options.isPublic ?? false,
          isPremium: options.isPremium ?? false,
          createdBy: options.createdBy
        }
      });

      return template;
    } catch (error) {
      console.error('Failed to create template:', error);
      return null;
    }
  }

  async listTemplates(
    userId: string,
    filters: ListTemplatesFilters = {},
    pagination: PaginationOptions = {}
  ): Promise<{ templates: DocumentTemplate[]; totalCount: number; }> {
    const conditions: Prisma.DocumentTemplateWhereInput[] = [
      {
        OR: [
          { createdBy: userId },
          { isPublic: true }
        ]
      }
    ];

    if (filters.category) {
      conditions.push({ category: filters.category });
    }

    if (filters.practiceArea) {
      conditions.push({ practiceArea: filters.practiceArea });
    }

    if (typeof filters.isPublic === 'boolean') {
      conditions.push({ isPublic: filters.isPublic });
    }

    if (filters.search) {
      conditions.push({
        OR: [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } }
        ]
      });
    }

    const where: Prisma.DocumentTemplateWhereInput = {
      status: TemplateStatus.ACTIVE,
      AND: conditions
    };

    const take = pagination.limit && pagination.limit > 0 ? pagination.limit : 20;
    const skip = pagination.offset && pagination.offset > 0 ? pagination.offset : 0;

    const [templates, totalCount] = await Promise.all([
      prisma.documentTemplate.findMany({
        where,
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' }
        ],
        take,
        skip
      }),
      prisma.documentTemplate.count({ where })
    ]);

    return { templates, totalCount };
  }

  async generateDocument(options: GenerateDocumentOptions): Promise<GeneratedDocument | null> {
    try {
      const format = options.format ?? 'pdf';
      const template = await this.getTemplateForUser(options.templateId, options.userId);

      if (!template) {
        throw new Error('Template not found or access denied');
      }

      const definitions = this.parseVariableDefinitions(template.templateVariables);
      const sampleData = this.parseSampleData(template.sampleData);
      const validationIssues = this.validateVariableData(definitions, options.variables, sampleData);

      const errors = validationIssues.filter(issue => issue.severity === 'error');
      if (errors.length > 0) {
        throw new Error(`Variable validation failed: ${errors.map(issue => issue.message).join(', ')}`);
      }

      const resolvedVariables = this.resolveVariables(definitions, options.variables, sampleData);
      const compiledHtml = await this.compileTemplate(template, resolvedVariables);

      const fileBuffer = format === 'html'
        ? Buffer.from(compiledHtml, 'utf-8')
        : await this.renderToPdf(compiledHtml);

      const tempDir = path.join(process.cwd(), 'temp-uploads');
      await this.ensureTempDirectory(tempDir);

      const fileName = this.determineFileName(template.name, format, options.fileName);
      const tempFilePath = path.join(tempDir, fileName);

      await writeFileAsync(tempFilePath, fileBuffer);

      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: fileName,
        encoding: '7bit',
        mimetype: this.getMimeType(format),
        size: fileBuffer.length,
        buffer: fileBuffer,
        destination: tempDir,
        filename: fileName,
        path: tempFilePath,
        stream: null as any
      };

      let uploadResult;
      try {
        uploadResult = await documentService.processDocument(mockFile, {
          userId: options.userId,
          folderId: options.folderId,
          category: DocumentCategory.TEMPLATE,
          securityLevel: SecurityLevel.STANDARD,
          description: `Generated from template: ${template.name}`,
          isTemplate: false,
          tags: ['generated', 'template']
        });
      } finally {
        await this.cleanupTempFile(tempFilePath);
      }

      if (!uploadResult.success || !uploadResult.document) {
        throw new Error(uploadResult.error || 'Document processing failed');
      }

      const generatedDocument = await prisma.generatedDocument.create({
        data: {
          templateId: template.id,
          documentId: uploadResult.document.id,
          generatedBy: options.userId,
          variableData: JSON.parse(JSON.stringify(resolvedVariables)) as Prisma.InputJsonValue
        }
      });

      return generatedDocument;
    } catch (error) {
      console.error('Failed to generate document:', error);
      return null;
    }
  }

  private async getTemplateForUser(templateId: string, userId: string): Promise<DocumentTemplate | null> {
    return prisma.documentTemplate.findFirst({
      where: {
        id: templateId,
        status: TemplateStatus.ACTIVE,
        AND: [
          {
            OR: [
              { createdBy: userId },
              { isPublic: true }
            ]
          }
        ]
      }
    });
  }

  private parseVariableDefinitions(input: unknown): TemplateVariableDefinition[] {
    if (Array.isArray(input)) {
      return input
        .map(item => {
          if (!item || typeof item !== 'object') {
            return null;
          }
          const record = item as Record<string, unknown>;
          const name = typeof record.name === 'string' ? record.name.trim() : '';
          const rawType = typeof record.type === 'string' ? record.type : 'text';
          if (!name) {
            return null;
          }
          const type: TemplateVariableType = ['text', 'number', 'date', 'boolean'].includes(rawType)
            ? rawType as TemplateVariableType
            : 'text';

          const options = Array.isArray(record.options)
            ? (record.options as unknown[]).filter((opt): opt is string => typeof opt === 'string')
            : undefined;

          return {
            name,
            label: typeof record.label === 'string' ? record.label : undefined,
            type,
            required: Boolean(record.required),
            defaultValue: record.defaultValue,
            options
          } as TemplateVariableDefinition;
        })
        .filter((value): value is TemplateVariableDefinition => value !== null);
    }

    return [];
  }

  private parseSampleData(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    return {};
  }

  private validateTemplateDefinition(content: string, variables: TemplateVariableDefinition[]): TemplateValidationResult {
    const issues: TemplateValidationIssue[] = [];

    try {
      Handlebars.compile(content);
    } catch (error) {
      issues.push({
        field: 'templateContent',
        message: `Template syntax error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'error'
      });
    }

    const placeholderPattern = /\{\{\s*([A-Za-z0-9_]+)\s*}}/g;
    const placeholders = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = placeholderPattern.exec(content)) !== null) {
      placeholders.add(match[1]);
    }

    const definedNames = new Set(variables.map(variable => variable.name));

    placeholders.forEach(name => {
      if (!definedNames.has(name)) {
        issues.push({
          field: name,
          message: `Variable "${name}" is used in the template but not defined`,
          severity: 'error'
        });
      }
    });

    const seen = new Set<string>();
    variables.forEach(variable => {
      if (seen.has(variable.name)) {
        issues.push({
          field: variable.name,
          message: `Variable "${variable.name}" is defined more than once`,
          severity: 'error'
        });
      }
      seen.add(variable.name);

      if (!placeholders.has(variable.name)) {
        issues.push({
          field: variable.name,
          message: `Variable "${variable.name}" is defined but never used`,
          severity: 'warning'
        });
      }
    });

    return {
      isValid: !issues.some(issue => issue.severity === 'error'),
      issues
    };
  }

  private validateVariableData(
    definitions: TemplateVariableDefinition[],
    provided: Record<string, unknown>,
    sampleData: Record<string, unknown>
  ): TemplateValidationIssue[] {
    const issues: TemplateValidationIssue[] = [];

    definitions.forEach(definition => {
      const value = provided[definition.name] ?? sampleData[definition.name] ?? definition.defaultValue;

      if (value === undefined || value === null || value === '') {
        if (definition.required) {
          issues.push({
            field: definition.name,
            message: `Variable "${definition.name}" is required`,
            severity: 'error'
          });
        }
        return;
      }

      switch (definition.type) {
        case 'text':
          if (typeof value !== 'string') {
            issues.push({
              field: definition.name,
              message: `Variable "${definition.name}" must be a text value`,
              severity: 'error'
            });
          }
          break;
        case 'number':
          if (typeof value !== 'number') {
            issues.push({
              field: definition.name,
              message: `Variable "${definition.name}" must be a number`,
              severity: 'error'
            });
          }
          break;
        case 'date':
          if (!(value instanceof Date) && Number.isNaN(Date.parse(String(value)))) {
            issues.push({
              field: definition.name,
              message: `Variable "${definition.name}" must be a valid date`,
              severity: 'error'
            });
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            issues.push({
              field: definition.name,
              message: `Variable "${definition.name}" must be a boolean`,
              severity: 'error'
            });
          }
          break;
        default:
          break;
      }

      if (definition.options && definition.options.length > 0) {
        if (typeof value !== 'string' || !definition.options.includes(value)) {
          issues.push({
            field: definition.name,
            message: `Variable "${definition.name}" must be one of: ${definition.options.join(', ')}`,
            severity: 'error'
          });
        }
      }
    });

    return issues;
  }

  private resolveVariables(
    definitions: TemplateVariableDefinition[],
    provided: Record<string, unknown>,
    sampleData: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    definitions.forEach(definition => {
      if (Object.prototype.hasOwnProperty.call(provided, definition.name)) {
        resolved[definition.name] = provided[definition.name];
      } else if (Object.prototype.hasOwnProperty.call(sampleData, definition.name)) {
        resolved[definition.name] = sampleData[definition.name];
      } else if (definition.defaultValue !== undefined) {
        resolved[definition.name] = definition.defaultValue;
      }
    });

    Object.keys(provided).forEach(key => {
      if (resolved[key] === undefined) {
        resolved[key] = provided[key];
      }
    });

    return resolved;
  }

  private async compileTemplate(template: DocumentTemplate, variables: Record<string, unknown>): Promise<string> {
    this.registerHandlebarsHelpers();

    const content = template.templateContent ?? '';
    const compiled = Handlebars.compile(content);

    const context = {
      ...variables,
      _template: {
        id: template.id,
        name: template.name,
        category: template.category,
        version: template.version,
        generatedAt: new Date().toISOString()
      }
    };

    return compiled(context);
  }

  private registerHandlebarsHelpers(): void {
    if (this.helpersRegistered) {
      return;
    }

    Handlebars.registerHelper('formatDate', (value: unknown, format: string = 'short') => {
      if (!value) return '';

      let date: Date | null = null;
      if (value instanceof Date) {
        date = value;
      } else if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          date = parsed;
        }
      }

      if (!date) {
        return '';
      }

      switch (format) {
        case 'long':
          return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        case 'iso':
          return date.toISOString();
        case 'time':
          return date.toLocaleTimeString();
        default:
          return date.toLocaleDateString();
      }
    });

    Handlebars.registerHelper('uppercase', (value: unknown) => typeof value === 'string' ? value.toUpperCase() : '');
    Handlebars.registerHelper('lowercase', (value: unknown) => typeof value === 'string' ? value.toLowerCase() : '');
    Handlebars.registerHelper('formatCurrency', (amount: unknown, currency: string = 'USD') => {
      if (typeof amount !== 'number') {
        return '';
      }
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    });

    this.helpersRegistered = true;
  }

  private async renderToPdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const buffer = await page.pdf({ format: 'A4' });
      await page.close();
      return buffer;
    } finally {
      await browser.close();
    }
  }

  private async ensureTempDirectory(directory: string): Promise<void> {
    try {
      await accessAsync(directory, fs.constants.F_OK);
    } catch {
      await mkdirAsync(directory, { recursive: true });
    }
  }

  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await unlinkAsync(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }

  private determineFileName(templateName: string, format: string, customName?: string): string {
    const base = customName?.trim() || `${templateName}-${Date.now()}`;
    const sanitized = this.sanitizeFileName(base);
    const extension = format === 'html' ? 'html' : 'pdf';

    return sanitized.endsWith(`.${extension}`) ? sanitized : `${sanitized}.${extension}`;
  }

  private sanitizeFileName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9-_\.]+/g, '_');
    const collapsed = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return collapsed || 'document';
  }

  private getMimeType(format: 'html' | 'pdf'): string {
    return format === 'html' ? 'text/html; charset=utf-8' : 'application/pdf';
  }
}

export default new DocumentTemplatesService();
export {
  DocumentTemplatesService,
  CreateTemplateOptions,
  ListTemplatesFilters,
  PaginationOptions,
  GenerateDocumentOptions,
  TemplateVariableDefinition,
  TemplateValidationIssue,
  TemplateValidationResult
};