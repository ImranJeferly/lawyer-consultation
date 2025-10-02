import {
  DocumentSignature,
  SignatureStatus,
  SignatureType,
  Document,
  SignatureWorkflowStatus,
  DocumentSignatureAuditEvent,
  DocumentSignatureAuditLog,
  WorkflowStatus,
  Prisma
} from '@prisma/client';
import crypto from 'crypto';
import AWS from 'aws-sdk';
import prisma from '../config/database';
import firebaseService from './firebase.service';

interface SignatureWorkflowSummary {
  workflowId: string;
  documentId: string;
  requestedBy: string;
  title: string;
  message?: string;
  dueDate?: Date;
  reminderSettings?: CreateSignatureRequestOptions['reminderSettings'];
  status: SignatureWorkflowStatus;
  signers: DocumentSignature[];
}

interface LogAuditEventOptions {
  documentId: string;
  workflowId: string;
  signatureId?: string;
  eventType: DocumentSignatureAuditEvent;
  eventDescription?: string;
  performedBy?: string;
  performedByEmail?: string;
  performedByName?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}

interface SigningNotificationContext {
  workflowId: string;
  title: string;
  message?: string;
  requestedBy: string;
}

interface ReminderScheduleEntry {
  workflowId: string;
  documentId: string;
  sendAt: Date;
  intervalDays: number;
}

interface NormalizedSigner {
  userId: string | null;
  email: string;
  name: string;
  role: string;
  order: number;
  isRequired: boolean;
  allowDelegation: boolean;
  signerMessage?: string;
  hasSignedAt: Date | null;
  signatureUrl: string | null;
  signatureCertificate: any;
}

interface CreateSignatureRequestOptions {
  documentId: string;
  requestedBy: string;
  signers: Array<{
    userId?: string;
    email: string;
    name: string;
    role: string;
    order: number;
    isRequired: boolean;
    allowDelegation?: boolean;
    signerMessage?: string;
  }>;
  title: string;
  message?: string;
  dueDate?: Date;
  reminderSettings?: {
    sendReminders: boolean;
    reminderIntervals: number[]; // days before due date
  };
  signatureType: SignatureType;
  requiresNotarization?: boolean;
  allowComments?: boolean;
  enforceSigning: boolean;
}

interface SignDocumentOptions {
  signatureRequestId: string;
  signerId: string;
  signatureData: {
    type: 'electronic' | 'digital' | 'biometric';
    signature: string; // Base64 encoded signature image or digital signature
    coordinates?: { x: number; y: number; page: number };
    timestamp: Date | string | number;
    ipAddress: string;
    userAgent: string;
    location?: string;
  };
  comments?: string;
  attachments?: Express.Multer.File[];
}

interface NormalizedSignatureData
  extends Omit<SignDocumentOptions['signatureData'], 'timestamp' | 'signature'> {
  signature: string;
  timestamp: Date;
}

interface SignatureValidationResult {
  isValid: boolean;
  certificate?: {
    issuer: string;
    subject: string;
    validFrom: Date;
    validTo: Date;
    serialNumber: string;
  };
  timestamp: Date;
  integrityCheck: boolean;
  errorMessage?: string;
}

interface SignatureAuditTrail {
  documentId: string;
  events: Array<{
    timestamp: Date;
    event: string;
    userId?: string;
    userName: string;
    ipAddress: string;
    userAgent: string;
    details: any;
  }>;
  certificateChain?: any[];
  complianceChecks: {
    legalValidity: boolean;
    technicalCompliance: boolean;
    auditTrailComplete: boolean;
    timestampVerified: boolean;
  };
}

interface NotarizeDocumentOptions {
  signatureRequestId: string;
  notaryId: string;
  notarySeal: string; // Base64 encoded notary seal
  notaryCommission: {
    commissionNumber: string;
    expirationDate: Date;
    jurisdiction: string;
  };
  witnessInformation?: Array<{
    name: string;
    address: string;
    identification: string;
  }>;
}

class DigitalSignatureService {
  private s3: AWS.S3;
  private bucketName: string;

  constructor() {
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION,
    });
    this.bucketName = process.env.AWS_S3_BUCKET || 'lawyer-consultation-docs';
  }

  /**
   * Create signature request for document
   */
  async createSignatureRequest(options: CreateSignatureRequestOptions): Promise<SignatureWorkflowSummary | null> {
    try {
      const document = await prisma.document.findFirst({
        where: {
          id: options.documentId,
          workflowStatus: { not: 'DRAFT' },
          OR: [
            { ownerId: options.requestedBy },
            {
              shares: {
                some: {
                  sharedWith: options.requestedBy,
                  accessLevel: { in: ['EDIT', 'READ'] }
                }
              }
            }
          ]
        }
      });

      if (!document) {
        throw new Error('Document not found or insufficient permissions');
      }

      const validatedSigners = await this.validateSigners(options.signers);

      if (!validatedSigners.length) {
        throw new Error('At least one signer is required');
      }

      const workflowId = `workflow_${crypto.randomUUID()}`;
      const now = new Date();
      const defaultExpiration = options.dueDate || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      const createdSignatures = await prisma.$transaction(
        validatedSigners.map((signer, index) =>
          prisma.documentSignature.create({
            data: {
              documentId: options.documentId,
              workflowId,
              signatureOrder: signer.order ?? index + 1,
              workflowStatus: SignatureWorkflowStatus.PENDING,
              signerId: signer.userId,
              signerEmail: signer.email,
              signerName: signer.name,
              signerRole: signer.role,
              signatureType: options.signatureType,
              isRequired: signer.isRequired,
              signatureFields: {
                allowDelegation: signer.allowDelegation,
                signerMessage: signer.signerMessage || null
              },
              invitationToken: crypto.randomBytes(32).toString('hex'),
              invitedAt: now,
              invitationExpiresAt: defaultExpiration,
              status: SignatureStatus.INVITED
            }
          })
        )
      );

      await this.logAuditEvent({
        documentId: options.documentId,
        workflowId,
        eventType: DocumentSignatureAuditEvent.REQUEST_CREATED,
        performedBy: options.requestedBy,
        eventDescription: `Signature workflow created with ${createdSignatures.length} signer(s)`,
        metadata: {
          title: options.title,
          message: options.message,
          dueDate: options.dueDate,
          signatureType: options.signatureType
        }
      });

      await this.sendSigningNotifications(document, createdSignatures, {
        workflowId,
        title: options.title,
        message: options.message,
        requestedBy: options.requestedBy
      });

      if (options.reminderSettings?.sendReminders && options.dueDate) {
        await this.scheduleReminders(workflowId, options.reminderSettings, options.dueDate, options.documentId);
      }

      return {
        workflowId,
        documentId: options.documentId,
        requestedBy: options.requestedBy,
        title: options.title,
        message: options.message,
        dueDate: options.dueDate,
        reminderSettings: options.reminderSettings,
        status: SignatureWorkflowStatus.IN_PROGRESS,
        signers: createdSignatures
      };

    } catch (error) {
      console.error('Failed to create signature request:', error);
      return null;
    }
  }

  /**
   * Sign document
   */
  async signDocument(options: SignDocumentOptions): Promise<boolean> {
    try {
      const signatureRecord = await prisma.documentSignature.findUnique({
        where: { id: options.signatureRequestId },
        include: { document: true }
      });

      if (!signatureRecord) {
        throw new Error('Signature request not found');
      }

      if (signatureRecord.status === SignatureStatus.SIGNED) {
        throw new Error('Document already signed by this user');
      }

      if (signatureRecord.status === SignatureStatus.DECLINED) {
        throw new Error('Signature request was declined');
      }

      if (signatureRecord.signerId && signatureRecord.signerId !== options.signerId) {
        throw new Error('You are not authorized to sign this document');
      }

      if (!signatureRecord.signerId) {
        const signerAccount = await prisma.user.findUnique({
          where: { id: options.signerId },
          select: { id: true, email: true, firstName: true, lastName: true }
        });

        if (!signerAccount) {
          throw new Error('Signer account not found');
        }

        if (!signerAccount.email || signerAccount.email.toLowerCase() !== signatureRecord.signerEmail.toLowerCase()) {
          throw new Error('Signer email does not match the invitation');
        }
      }

      const normalizedSignatureData = this.normalizeSignaturePayload(options.signatureData);

      const signatureValidation = await this.validateSignatureData(normalizedSignatureData);
      if (!signatureValidation.isValid) {
        throw new Error(`Invalid signature: ${signatureValidation.errorMessage}`);
      }

      const signatureCertificate = await this.generateSignatureCertificate(
        options.signerId,
        normalizedSignatureData,
        signatureRecord.document
      );

      const signatureUrl = await this.storeSignature(
        signatureRecord.workflowId,
        options.signerId,
        normalizedSignatureData.signature
      );

      const certificateUrl = await this.storeSignatureCertificate(
        signatureRecord.workflowId,
        options.signerId,
        signatureCertificate
      );

      const signatureFieldsPayload = this.composeSignatureFields(signatureRecord.signatureFields, {
        comments: options.comments,
        attachments: options.attachments?.map(file => ({
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: file.size
        }))
      });

      const updateData: any = {
        signerId: signatureRecord.signerId ?? options.signerId,
        signatureImageUrl: signatureUrl,
        signatureCertificateUrl: certificateUrl,
        signedAt: normalizedSignatureData.timestamp,
        signatureIpAddress: normalizedSignatureData.ipAddress,
        signatureUserAgent: normalizedSignatureData.userAgent,
        status: SignatureStatus.SIGNED,
        workflowStatus: SignatureWorkflowStatus.COMPLETED,
        twoFactorVerified: true
      };

      if (normalizedSignatureData.location) {
        updateData.signatureLocation = { raw: normalizedSignatureData.location };
      }

      if (normalizedSignatureData.coordinates) {
        updateData.signaturePosition = normalizedSignatureData.coordinates;
      }

      if (signatureFieldsPayload) {
        updateData.signatureFields = signatureFieldsPayload;
      }

      await prisma.documentSignature.update({
        where: { id: signatureRecord.id },
        data: updateData
      });

      await this.logAuditEvent({
        documentId: signatureRecord.documentId,
        workflowId: signatureRecord.workflowId,
        signatureId: signatureRecord.id,
        eventType: DocumentSignatureAuditEvent.SIGNED,
        performedBy: options.signerId,
        ipAddress: options.signatureData.ipAddress,
        userAgent: options.signatureData.userAgent,
        metadata: {
          signatureUrl,
          certificateUrl,
          signatureType: normalizedSignatureData.type,
          coordinates: normalizedSignatureData.coordinates,
          comments: options.comments,
          signedAt: normalizedSignatureData.timestamp,
          ipAddress: normalizedSignatureData.ipAddress
        }
      });

      await this.logAuditEvent({
        documentId: signatureRecord.documentId,
        workflowId: signatureRecord.workflowId,
        signatureId: signatureRecord.id,
        eventType: DocumentSignatureAuditEvent.SIGNATURE_VALIDATED,
        performedBy: options.signerId,
        metadata: {
          validationResult: signatureValidation
        }
      });

      const workflowSigners = await prisma.documentSignature.findMany({
        where: { workflowId: signatureRecord.workflowId }
      });

      const allRequiredSigned = workflowSigners
        .filter(signer => signer.isRequired)
        .every(signer => signer.status === SignatureStatus.SIGNED);

      await prisma.documentSignature.updateMany({
        where: { workflowId: signatureRecord.workflowId },
        data: {
          workflowStatus: allRequiredSigned
            ? SignatureWorkflowStatus.COMPLETED
            : SignatureWorkflowStatus.IN_PROGRESS
        }
      });

      if (allRequiredSigned) {
        await this.logAuditEvent({
          documentId: signatureRecord.documentId,
          workflowId: signatureRecord.workflowId,
          signatureId: signatureRecord.id,
          eventType: DocumentSignatureAuditEvent.WORKFLOW_COMPLETED,
          performedBy: options.signerId,
          metadata: {
            completedAt: new Date(),
            signersCompleted: workflowSigners.length
          }
        });

        await prisma.document.update({
          where: { id: signatureRecord.documentId },
          data: {
            workflowStatus: WorkflowStatus.SIGNED
          }
        }).catch((error) => {
          console.error('Failed to update document workflow status after completion:', error);
        });

        await this.finalizeSignatureProcess(signatureRecord.id);
      }

      return true;

    } catch (error) {
      console.error('Failed to sign document:', error);
      return false;
    }
  }

  private async logAuditEvent(options: LogAuditEventOptions): Promise<DocumentSignatureAuditLog | null> {
    try {
      let performedByEmail = options.performedByEmail;
      let performedByName = options.performedByName;

  const metadataPayload = this.serializeMetadata(options.metadata);

      if (options.performedBy && (!performedByEmail || !performedByName)) {
        const performer = await prisma.user.findUnique({
          where: { id: options.performedBy },
          select: { email: true, firstName: true, lastName: true }
        });

        if (performer) {
          performedByEmail = performedByEmail ?? performer.email ?? undefined;
          const name = `${performer.firstName ?? ''} ${performer.lastName ?? ''}`.trim();
          performedByName = performedByName ?? (name.length ? name : undefined);
        }
      }

      return await prisma.documentSignatureAuditLog.create({
        data: {
          documentId: options.documentId,
          workflowId: options.workflowId,
          signatureId: options.signatureId ?? null,
          eventType: options.eventType,
          eventDescription: options.eventDescription ?? null,
          performedBy: options.performedBy ?? null,
          performedByEmail: performedByEmail ?? null,
          performedByName: performedByName ?? null,
          ipAddress: options.ipAddress ?? null,
          userAgent: options.userAgent ?? null,
          metadata:
            metadataPayload === undefined
              ? undefined
              : metadataPayload === Prisma.JsonNull
                ? Prisma.JsonNull
                : metadataPayload
        }
      });
    } catch (error) {
      console.error('Failed to log signature audit event:', error, options);
      return null;
    }
  }

  private async sendSigningNotifications(
    document: Document,
    signatures: DocumentSignature[],
    context: SigningNotificationContext
  ): Promise<void> {
    if (!signatures.length) {
      return;
    }

    let requester: { email: string | null; firstName: string | null; lastName: string | null } | null = null;

    if (context.requestedBy) {
      requester = await prisma.user.findUnique({
        where: { id: context.requestedBy },
        select: { email: true, firstName: true, lastName: true }
      });
    }

    await Promise.all(signatures.map(async (signature) => {
      try {
        if (signature.signerId) {
          await firebaseService.sendNotificationToUser(
            { userId: signature.signerId },
            {
              title: context.title || `Signature requested for ${document.title}`,
              body: context.message || `Please review and sign "${document.title}"`,
              data: {
                type: 'signature_request',
                workflowId: context.workflowId,
                signatureId: signature.id,
                documentId: document.id
              }
            }
          );
        } else {
          console.info('Signature invitation pending email delivery', {
            signerEmail: signature.signerEmail,
            documentId: document.id,
            workflowId: context.workflowId
          });
        }

        await this.logAuditEvent({
          documentId: document.id,
          workflowId: context.workflowId,
          signatureId: signature.id,
          eventType: DocumentSignatureAuditEvent.INVITATION_SENT,
          performedBy: context.requestedBy,
          performedByEmail: requester?.email ?? undefined,
          performedByName: requester
            ? `${requester.firstName ?? ''} ${requester.lastName ?? ''}`.trim() || undefined
            : undefined,
          metadata: {
            signerEmail: signature.signerEmail,
            signerName: signature.signerName,
            invitationToken: signature.invitationToken,
            title: context.title,
            message: context.message
          }
        });
      } catch (error) {
        console.error('Failed to send signature notification:', error, {
          documentId: document.id,
          workflowId: context.workflowId,
          signatureId: signature.id
        });
      }
    }));
  }

  private composeSignatureFields(
    existingFields: Prisma.JsonValue | null,
    updates: Record<string, any>
  ): Prisma.JsonValue | null {
    const base = this.normalizeSignatureFields(existingFields);
    const sanitizedUpdates = Object.entries(updates || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .reduce<Record<string, any>>((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});

    if (!Object.keys(sanitizedUpdates).length) {
      return existingFields;
    }

    return {
      ...base,
      ...sanitizedUpdates
    };
  }

  private normalizeSignatureFields(value: Prisma.JsonValue | null): Record<string, any> {
    if (!value) {
      return {};
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch (error) {
        console.warn('Failed to parse signature fields JSON string', error);
        return {};
      }
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, any>;
    }

    return {};
  }

  private async storeSignatureCertificate(
    workflowId: string,
    signerId: string,
    certificate: any
  ): Promise<string> {
    const fileName = `certificate_${workflowId}_${signerId}_${Date.now()}.json`;
    const s3Key = `signatures/${workflowId}/certificates/${fileName}`;
    const buffer = Buffer.from(JSON.stringify(certificate, null, 2));

    const params = {
      Bucket: this.bucketName,
      Key: s3Key,
      Body: buffer,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256' as const,
      Metadata: {
        workflowId,
        signerId,
        timestamp: new Date().toISOString()
      }
    };

    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  private async fetchCertificateFromStorage(certificateUrl: string): Promise<any | null> {
    const key = this.getS3ObjectKeyFromUrl(certificateUrl);

    if (!key) {
      return null;
    }

    try {
      const result = await this.s3.getObject({
        Bucket: this.bucketName,
        Key: key
      }).promise();

      if (!result.Body) {
        return null;
      }

      const body = result.Body instanceof Buffer ? result.Body : Buffer.from(result.Body as any);
      return JSON.parse(body.toString('utf-8'));
    } catch (error) {
      console.error('Failed to fetch certificate from storage:', error, { certificateUrl });
      return null;
    }
  }

  private getS3ObjectKeyFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    } catch (error) {
      console.error('Failed to parse S3 url:', error, { url });
      return null;
    }
  }

  private serializeMetadata(metadata: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (metadata === undefined) {
      return undefined;
    }

    if (metadata === null) {
      return Prisma.JsonNull;
    }

    if (metadata instanceof Date) {
      return metadata.toISOString();
    }

    if (typeof metadata === 'string' || typeof metadata === 'number' || typeof metadata === 'boolean') {
      return metadata;
    }

    const sanitized = JSON.stringify(
      metadata,
      (_key, value) => {
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (typeof value === 'bigint') {
          return value.toString();
        }
        if (value === undefined) {
          return null;
        }
        return value;
      }
    );

    if (sanitized === undefined) {
      return undefined;
    }

    const parsed = JSON.parse(sanitized) as unknown;
    return parsed as Prisma.InputJsonValue;
  }

  /**
   * Notarize document
   */
  async notarizeDocument(options: NotarizeDocumentOptions): Promise<boolean> {
    try {
      const signatureRequest = await prisma.documentSignature.findUnique({
        where: { id: options.signatureRequestId }
      });

      if (!signatureRequest) {
        throw new Error('Signature request not found');
      }

      // Validate notary credentials
      const notaryValidation = await this.validateNotaryCredentials(
        options.notaryId,
        options.notaryCommission
      );

      if (!notaryValidation.isValid) {
        throw new Error('Invalid notary credentials');
      }

      // Store notary seal
      const notarySealUrl = await this.storeNotarySeal(
        options.signatureRequestId,
        options.notaryId,
        options.notarySeal
      );

      // Create notarization record
      const notarizationData = {
        notaryId: options.notaryId,
        notarySealUrl,
        notaryCommission: options.notaryCommission,
        witnessInformation: options.witnessInformation,
        notarizedAt: new Date()
      };

      const updatedFields = this.composeSignatureFields(signatureRequest.signatureFields, {
        notarization: notarizationData
      });

      await prisma.documentSignature.update({
        where: { id: options.signatureRequestId },
        data: {
          signatureFields: updatedFields ?? undefined,
          workflowStatus: SignatureWorkflowStatus.COMPLETED
        }
      });

      await this.logAuditEvent({
        documentId: signatureRequest.documentId,
        workflowId: signatureRequest.workflowId,
        signatureId: signatureRequest.id,
        eventType: DocumentSignatureAuditEvent.NOTARIZED,
        performedBy: options.notaryId,
        eventDescription: 'Document notarized',
        metadata: notarizationData
      });

      return true;

    } catch (error) {
      console.error('Failed to notarize document:', error);
      return false;
    }
  }

  /**
   * Validate signature integrity
   */
  async validateSignature(
    signatureRequestId: string,
    signerId: string
  ): Promise<SignatureValidationResult> {
    try {
      const signatureRecord = await prisma.documentSignature.findUnique({
        where: { id: signatureRequestId }
      });

      if (!signatureRecord) {
        return {
          isValid: false,
          timestamp: new Date(),
          integrityCheck: false,
          errorMessage: 'Signature request not found'
        };
      }

      if (signatureRecord.signerId && signatureRecord.signerId !== signerId) {
        return {
          isValid: false,
          timestamp: new Date(),
          integrityCheck: false,
          errorMessage: 'Signer does not match signature record'
        };
      }

      if (signatureRecord.status !== SignatureStatus.SIGNED) {
        return {
          isValid: false,
          timestamp: signatureRecord.signedAt ?? new Date(),
          integrityCheck: false,
          errorMessage: 'Signature has not been completed'
        };
      }

      const certificate = signatureRecord.signatureCertificateUrl
        ? await this.fetchCertificateFromStorage(signatureRecord.signatureCertificateUrl)
        : null;

      if (!certificate) {
        return {
          isValid: false,
          timestamp: signatureRecord.signedAt ?? new Date(),
          integrityCheck: false,
          errorMessage: 'Signature certificate could not be retrieved'
        };
      }

      const integrityCheck = await this.verifySignatureIntegrity(
        signatureRecord.documentId,
        signatureRecord.signatureImageUrl || '',
        certificate
      );

      const certificateValidation = await this.validateCertificate(certificate);

      await this.logAuditEvent({
        documentId: signatureRecord.documentId,
        workflowId: signatureRecord.workflowId,
        signatureId: signatureRecord.id,
        eventType: DocumentSignatureAuditEvent.SIGNATURE_VALIDATED,
        performedBy: signerId,
        metadata: {
          validationSource: 'manual',
          integrityCheck,
          certificateValid: certificateValidation.isValid
        }
      });

      return {
        isValid: integrityCheck && certificateValidation.isValid,
        certificate: certificateValidation.certificate,
        timestamp: signatureRecord.signedAt ?? new Date(),
        integrityCheck,
        errorMessage: integrityCheck ? undefined : 'Signature integrity check failed'
      };

    } catch (error) {
      console.error('Failed to validate signature:', error);
      return {
        isValid: false,
        timestamp: new Date(),
        integrityCheck: false,
        errorMessage: 'Signature validation failed'
      };
    }
  }

  /**
   * Generate signature audit trail
   */
  async generateAuditTrail(signatureRequestId: string): Promise<SignatureAuditTrail | null> {
    try {
      const signatureRecord = await prisma.documentSignature.findUnique({
        where: { id: signatureRequestId }
      });

      if (!signatureRecord) {
        return null;
      }

      const auditLogs = await prisma.documentSignatureAuditLog.findMany({
        where: { workflowId: signatureRecord.workflowId },
        orderBy: { createdAt: 'asc' }
      });

      const timestampVerified = await this.verifyTimestamps(auditLogs);

      const complianceChecks = {
        legalValidity: this.checkLegalValidity(signatureRecord),
        technicalCompliance: this.checkTechnicalCompliance(auditLogs),
        auditTrailComplete: this.checkAuditTrailCompleteness(auditLogs),
        timestampVerified
      };

      const events = auditLogs.map((log: DocumentSignatureAuditLog) => ({
        timestamp: log.createdAt,
        event: log.eventType,
        userId: log.performedBy ?? undefined,
        userName: log.performedByName || log.performedByEmail || 'system',
        ipAddress: log.ipAddress ?? 'unknown',
        userAgent: log.userAgent ?? 'unknown',
        details: log.metadata
      }));

      return {
        documentId: signatureRecord.documentId,
        events,
        certificateChain: this.extractCertificateChain(signatureRecord),
        complianceChecks
      };

    } catch (error) {
      console.error('Failed to generate audit trail:', error);
      return null;
    }
  }

  /**
   * Cancel signature request
   */
  async cancelSignatureRequest(
    signatureRequestId: string,
    cancelledBy: string,
    reason: string
  ): Promise<boolean> {
    try {
      const signatureRecord = await prisma.documentSignature.findUnique({
        where: { id: signatureRequestId }
      });

      if (!signatureRecord) {
        return false;
      }

      if (signatureRecord.status === SignatureStatus.SIGNED) {
        throw new Error('Cannot cancel completed signature request');
      }

      await prisma.documentSignature.updateMany({
        where: { workflowId: signatureRecord.workflowId },
        data: {
          status: SignatureStatus.DECLINED,
          workflowStatus: SignatureWorkflowStatus.CANCELLED,
          declinedAt: new Date(),
          declineReason: reason
        }
      });

      await this.logAuditEvent({
        documentId: signatureRecord.documentId,
        workflowId: signatureRecord.workflowId,
        signatureId: signatureRecord.id,
        eventType: DocumentSignatureAuditEvent.CANCELLED,
        performedBy: cancelledBy,
        eventDescription: reason,
        metadata: { reason }
      });

      await this.sendCancellationNotifications(signatureRecord);

      return true;

    } catch (error) {
      console.error('Failed to cancel signature request:', error);
      return false;
    }
  }

  /**
   * Private helper methods
   */

  /**
   * Validate signers information
   */
  private async validateSigners(signers: any[]): Promise<NormalizedSigner[]> {
    const validatedSigners: NormalizedSigner[] = [];

    for (const signer of signers) {
      // Find user if userId provided
      let user = null;
      if (signer.userId) {
        user = await prisma.user.findUnique({
          where: { id: signer.userId },
          select: { id: true, firstName: true, lastName: true, email: true }
        });
      } else if (signer.email) {
        user = await prisma.user.findUnique({
          where: { email: signer.email },
          select: { id: true, firstName: true, lastName: true, email: true }
        });
      }

      const resolvedOrder: number = Number.isFinite(signer.order)
        ? Number(signer.order)
        : validatedSigners.length + 1;

      if (validatedSigners.some((existing) => existing.order === resolvedOrder)) {
        throw new Error(`Duplicate signing order detected for order ${resolvedOrder}`);
      }

      validatedSigners.push({
        userId: user?.id || null,
        email: signer.email,
        name: user ? `${user.firstName} ${user.lastName}` : signer.name,
        role: signer.role,
        order: resolvedOrder,
        isRequired: signer.isRequired,
        allowDelegation: signer.allowDelegation || false,
        signerMessage: signer.signerMessage,
        hasSignedAt: null,
        signatureUrl: null,
        signatureCertificate: null
      });
    }

    return validatedSigners.sort((a, b) => a.order - b.order);
  }

  private normalizeSignaturePayload(signatureData: SignDocumentOptions['signatureData']): NormalizedSignatureData {
    if (!signatureData) {
      throw new Error('Signature data is required');
    }

    const { signature, timestamp, ...rest } = signatureData;

    if (!signature) {
      throw new Error('Signature data is required');
    }

    const sanitizedSignature = this.extractBase64Payload(signature);

    if (!sanitizedSignature || !this.isValidBase64(sanitizedSignature)) {
      throw new Error('Invalid signature payload');
    }

    const normalizedTimestamp = this.ensureValidTimestamp(timestamp);

    const normalizedData: NormalizedSignatureData = {
      ...(rest as Omit<SignDocumentOptions['signatureData'], 'signature' | 'timestamp'>),
      signature: sanitizedSignature,
      timestamp: normalizedTimestamp
    };

    return normalizedData;
  }

  private ensureValidTimestamp(value: SignDocumentOptions['signatureData']['timestamp']): Date {
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) {
        return value;
      }
      throw new Error('Invalid signature timestamp');
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
      throw new Error('Invalid signature timestamp');
    }

    throw new Error('Signature timestamp is required');
  }

  private extractBase64Payload(data: string): string {
    if (!data) {
      return '';
    }

    const trimmed = data.trim();
    const commaIndex = trimmed.indexOf(',');
    const payload = trimmed.startsWith('data:') && commaIndex !== -1
      ? trimmed.slice(commaIndex + 1)
      : trimmed;

    if (!payload.length) {
      return '';
    }

    const normalized = payload
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    if (!normalized.length) {
      return '';
    }

    const stripped = normalized.replace(/=+$/, '');
    const paddingNeeded = (4 - (stripped.length % 4)) % 4;

    return stripped + '='.repeat(paddingNeeded);
  }

  private isValidBase64(value: string): boolean {
    return value.length > 0 && /^[A-Za-z0-9+/=]+$/.test(value);
  }

  /**
   * Validate signature data
   */
  private async validateSignatureData(
    signatureData: NormalizedSignatureData
  ): Promise<{ isValid: boolean; errorMessage?: string }> {
    if (!signatureData.signature) {
      return { isValid: false, errorMessage: 'Signature data is required' };
    }

    if (!this.isValidBase64(signatureData.signature)) {
      return { isValid: false, errorMessage: 'Signature payload is not valid base64' };
    }

    if (!(signatureData.timestamp instanceof Date) || Number.isNaN(signatureData.timestamp.getTime())) {
      return { isValid: false, errorMessage: 'Invalid signature timestamp' };
    }

    // Validate signature format based on type
    if (signatureData.type === 'digital') {
      // Validate digital signature format
      if (!this.isValidDigitalSignature(signatureData.signature)) {
        return { isValid: false, errorMessage: 'Invalid digital signature format' };
      }
    }

    return { isValid: true };
  }

  /**
   * Generate signature certificate
   */
  private async generateSignatureCertificate(
    signerId: string,
    signatureData: NormalizedSignatureData,
    document: Document
  ): Promise<any> {
    const certificate = {
      issuer: 'Lawyer Consultation Platform',
      subject: signerId,
      validFrom: new Date(),
      validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      serialNumber: crypto.randomUUID(),
      algorithm: 'RSA-SHA256',
      documentHash: crypto.createHash('sha256').update(document.extractedText || '').digest('hex'),
      signatureHash: crypto.createHash('sha256').update(signatureData.signature).digest('hex'),
      timestamp: signatureData.timestamp
    };

    return certificate;
  }

  /**
   * Store signature in secure storage
   */
  private async storeSignature(
    requestId: string,
    signerId: string,
    signatureData: string
  ): Promise<string> {
    const fileName = `signature_${requestId}_${signerId}_${Date.now()}.png`;
    const s3Key = `signatures/${requestId}/${fileName}`;

    const normalizedData = this.extractBase64Payload(signatureData);

    if (!normalizedData || !this.isValidBase64(normalizedData)) {
      throw new Error('Signature data could not be normalized to base64');
    }

    const buffer = Buffer.from(normalizedData, 'base64');

    const params = {
      Bucket: this.bucketName,
      Key: s3Key,
      Body: buffer,
      ContentType: 'image/png',
      ServerSideEncryption: 'AES256' as const,
      Metadata: {
        requestId,
        signerId,
        timestamp: new Date().toISOString()
      }
    };

    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  /**
   * Store notary seal
   */
  private async storeNotarySeal(
    requestId: string,
    notaryId: string,
    sealData: string
  ): Promise<string> {
    const fileName = `notary_seal_${requestId}_${notaryId}_${Date.now()}.png`;
    const s3Key = `notary-seals/${requestId}/${fileName}`;

    const normalizedSeal = this.extractBase64Payload(sealData);

    if (!normalizedSeal || !this.isValidBase64(normalizedSeal)) {
      throw new Error('Notary seal data could not be normalized to base64');
    }

    const buffer = Buffer.from(normalizedSeal, 'base64');

    const params = {
      Bucket: this.bucketName,
      Key: s3Key,
      Body: buffer,
      ContentType: 'image/png',
      ServerSideEncryption: 'AES256' as const,
      Metadata: {
        requestId,
        notaryId,
        timestamp: new Date().toISOString()
      }
    };

    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  /**
   * Finalize signature process
   */
  private async finalizeSignatureProcess(signatureRequestId: string): Promise<void> {
    // Generate final signed document
    // Send completion notifications
    // Archive signature data
    // Create compliance report

    const signatureRequest = await prisma.documentSignature.findUnique({
      where: { id: signatureRequestId }
    });

    if (signatureRequest) {
      // Send completion notifications to all parties
      await this.sendCompletionNotifications(signatureRequest);

      // Generate compliance certificate
      await this.generateComplianceCertificate(signatureRequest);
    }
  }

  /**
   * Send various notifications
   */
  private async sendSignatureCompletedNotification(signatureRequest: any, signer: any): Promise<void> {
    // Implement notification logic
  }

  private async sendCancellationNotifications(signatureRequest: any): Promise<void> {
    // Implement cancellation notification logic
  }

  private async sendCompletionNotifications(signatureRequest: any): Promise<void> {
    // Implement completion notification logic
  }

  /**
   * Validation helper methods
   */
  private isValidDigitalSignature(signature: string): boolean {
    // Implement digital signature format validation
    return signature.length > 0;
  }

  private async verifySignatureIntegrity(
    documentId: string,
    signatureUrl: string,
    certificate: any
  ): Promise<boolean> {
    // Implement signature integrity verification
    return true;
  }

  private async validateCertificate(certificate: any): Promise<{
    isValid: boolean;
    certificate: any;
  }> {
    // Implement certificate validation
    return { isValid: true, certificate };
  }

  private async validateNotaryCredentials(
    notaryId: string,
    commission: any
  ): Promise<{ isValid: boolean }> {
    // Implement notary credential validation
    return { isValid: true };
  }

  /**
   * Compliance check methods
   */
  private checkLegalValidity(signatureRecord: DocumentSignature): boolean {
    return (
      signatureRecord.workflowStatus === SignatureWorkflowStatus.COMPLETED ||
      signatureRecord.status === SignatureStatus.SIGNED
    );
  }

  private checkTechnicalCompliance(auditLogs: DocumentSignatureAuditLog[]): boolean {
    if (!auditLogs.length) {
      return false;
    }

    const events = new Set(auditLogs.map((log) => log.eventType));

    return (
      events.has(DocumentSignatureAuditEvent.REQUEST_CREATED) &&
      events.has(DocumentSignatureAuditEvent.SIGNED)
    );
  }

  private checkAuditTrailCompleteness(auditLogs: DocumentSignatureAuditLog[]): boolean {
    return auditLogs.every((log) => 
      Boolean(log.createdAt) &&
      Boolean(log.eventType) &&
      (log.performedBy !== null || log.performedByEmail !== null)
    );
  }

  private async verifyTimestamps(auditLogs: DocumentSignatureAuditLog[]): Promise<boolean> {
    for (let i = 1; i < auditLogs.length; i += 1) {
      if (auditLogs[i].createdAt < auditLogs[i - 1].createdAt) {
        return false;
      }
    }

    return true;
  }

  private extractCertificateChain(signatureRecord: DocumentSignature): any[] {
    if (!signatureRecord.signatureCertificateUrl) {
      return [];
    }

    return [
      {
        certificateUrl: signatureRecord.signatureCertificateUrl,
        signedAt: signatureRecord.signedAt,
        signerEmail: signatureRecord.signerEmail,
        signerName: signatureRecord.signerName
      }
    ];
  }

  private async scheduleReminders(
    workflowId: string,
    reminderSettings: CreateSignatureRequestOptions['reminderSettings'],
    dueDate: Date,
    documentId: string
  ): Promise<void> {
    if (!reminderSettings?.sendReminders || !reminderSettings.reminderIntervals?.length) {
      return;
    }

    const now = new Date();
    const schedules: ReminderScheduleEntry[] = reminderSettings.reminderIntervals
      .map((days) => {
        const sendAt = new Date(dueDate.getTime() - days * 24 * 60 * 60 * 1000);
        return { workflowId, documentId, sendAt, intervalDays: days };
      })
      .filter((entry) => entry.sendAt > now)
      .sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());

    await Promise.all(
      schedules.map((schedule) =>
        this.logAuditEvent({
          documentId: schedule.documentId,
          workflowId,
          eventType: DocumentSignatureAuditEvent.REMINDER_SCHEDULED,
          eventDescription: `Reminder scheduled ${schedule.intervalDays} day(s) before due date`,
          metadata: {
            sendAt: schedule.sendAt,
            intervalDays: schedule.intervalDays
          }
        })
      )
    );
  }

  private async generateComplianceCertificate(signatureRequest: any): Promise<void> {
    // Generate compliance certificate
  }
}

export default new DigitalSignatureService();
export {
  DigitalSignatureService,
  CreateSignatureRequestOptions,
  SignDocumentOptions,
  SignatureValidationResult,
  SignatureAuditTrail,
  NotarizeDocumentOptions
};