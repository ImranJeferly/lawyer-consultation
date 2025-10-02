import AWS from 'aws-sdk';
import { DocumentType, VerificationDocumentType, PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import crypto from 'crypto';
import path from 'path';

interface DocumentUploadConfig {
  allowedMimeTypes: string[];
  maxFileSize: number; // in bytes
  virusScanEnabled: boolean;
  encryptionEnabled: boolean;
}

interface UploadResult {
  success: boolean;
  storageUrl?: string;
  fileKey?: string;
  documentId?: string;
  error?: string;
  virusScanResult?: 'clean' | 'infected' | 'error';
}

interface DocumentMetadata {
  originalName: string;
  mimeType: string;
  fileSize: number;
  lawyerId: string;
  documentType: VerificationDocumentType;
  expirationDate?: Date;
  isRequired: boolean;
}

class DocumentUploadService {
  private s3: AWS.S3;
  private config: DocumentUploadConfig;
  private bucketReady: Promise<void>;

  constructor() {
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1'
    });

    if (!process.env.AWS_S3_BUCKET) {
      throw new Error('AWS_S3_BUCKET environment variable is required for document uploads');
    }

    this.config = {
      allowedMimeTypes: [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ],
      maxFileSize: 10 * 1024 * 1024, // 10MB
      virusScanEnabled: process.env.NODE_ENV === 'production',
      encryptionEnabled: true
    };

    this.bucketReady = this.ensureBucketsExist();
  }

  /**
   * Upload verification document
   */
  async uploadVerificationDocument(
    file: Buffer,
    metadata: DocumentMetadata
  ): Promise<UploadResult> {
    try {
      await this.bucketReady;

      // Validate file
      const validationResult = this.validateFile(file, metadata);
      if (!validationResult.isValid) {
        return {
          success: false,
          error: validationResult.error
        };
      }

      // Generate secure file key
      const fileKey = this.generateSecureFileKey(metadata);

      // Scan for viruses if enabled
      if (this.config.virusScanEnabled) {
        const scanResult = await this.scanForViruses(file);
        if (scanResult !== 'clean') {
          return {
            success: false,
            error: 'File failed security scan',
            virusScanResult: scanResult
          };
        }
      }

      // Encrypt file if enabled
      const processedFile = this.config.encryptionEnabled
        ? this.encryptFile(file)
        : file;

      // Upload to S3
      const uploadParams: AWS.S3.PutObjectRequest = {
        Bucket: this.resolveBucketName(),
        Key: fileKey,
        Body: processedFile,
        ContentType: metadata.mimeType,
        ServerSideEncryption: 'AES256',
        Metadata: {
          'original-name': metadata.originalName,
          'document-type': metadata.documentType,
          'lawyer-id': metadata.lawyerId,
          'upload-timestamp': new Date().toISOString(),
          'encrypted': this.config.encryptionEnabled.toString()
        },
        Tagging: `DocumentType=${metadata.documentType}&LawyerId=${metadata.lawyerId}&Sensitive=true`
      };

      const uploadResult = await this.s3.upload(uploadParams).promise();

      // Save document record to database
      const verificationDocument = await prisma.verificationDocument.create({
        data: {
          lawyerId: metadata.lawyerId,
          documentType: metadata.documentType,
          fileName: metadata.originalName,
          fileUrl: uploadResult.Location,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
          expirationDate: metadata.expirationDate,
          isRequired: metadata.isRequired,
          verificationStatus: 'pending'
        }
      });

      return {
        success: true,
        storageUrl: uploadResult.Location,
        fileKey: fileKey,
        documentId: verificationDocument.id
      };

    } catch (error) {
      console.error('Document upload error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed'
      };
    }
  }

  private resolveBucketName(): string {
    if (process.env.NODE_ENV === 'staging' && process.env.AWS_S3_BUCKET_STAGING) {
      return process.env.AWS_S3_BUCKET_STAGING;
    }

    return process.env.AWS_S3_BUCKET!;
  }

  private async ensureBucketsExist(): Promise<void> {
    const bucketNames = new Set(
      [process.env.AWS_S3_BUCKET, process.env.AWS_S3_BUCKET_STAGING]
        .filter((name): name is string => Boolean(name))
    );

    await Promise.all(
      Array.from(bucketNames).map(bucketName => this.ensureBucket(bucketName))
    );
  }

  private async ensureBucket(bucketName: string): Promise<void> {
    try {
      await this.s3.headBucket({ Bucket: bucketName }).promise();
    } catch (error) {
      const awsError = error as AWS.AWSError;
      if (awsError.statusCode === 404 || awsError.code === 'NotFound' || awsError.code === 'NoSuchBucket') {
        const params: AWS.S3.CreateBucketRequest = { Bucket: bucketName };
        if (this.s3.config.region && this.s3.config.region !== 'us-east-1') {
          params.CreateBucketConfiguration = {
            LocationConstraint: String(this.s3.config.region)
          };
        }

        try {
          await this.s3.createBucket(params).promise();
        } catch (createError) {
          const createAwsError = createError as AWS.AWSError;
          if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(createAwsError.code ?? '')) {
            throw createError;
          }
        }

        await this.s3.waitFor('bucketExists', { Bucket: bucketName }).promise();
      } else {
        console.error(`Failed to validate bucket ${bucketName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Validate uploaded file
   */
  private validateFile(file: Buffer, metadata: DocumentMetadata): {
    isValid: boolean;
    error?: string;
  } {
    // Check file size
    if (file.length > this.config.maxFileSize) {
      return {
        isValid: false,
        error: `File size exceeds maximum allowed size of ${this.config.maxFileSize / (1024 * 1024)}MB`
      };
    }

    // Check MIME type
    if (!this.config.allowedMimeTypes.includes(metadata.mimeType)) {
      return {
        isValid: false,
        error: `File type ${metadata.mimeType} is not allowed`
      };
    }

    // Check file signature (magic numbers) to prevent MIME type spoofing
    const fileSignature = this.getFileSignature(file);
    if (!this.isValidFileSignature(fileSignature, metadata.mimeType)) {
      return {
        isValid: false,
        error: 'File signature does not match MIME type'
      };
    }

    return { isValid: true };
  }

  /**
   * Generate secure file key for S3 storage
   */
  private generateSecureFileKey(metadata: DocumentMetadata): string {
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(16).toString('hex');
    const extension = path.extname(metadata.originalName);

    return `verification-documents/${metadata.lawyerId}/${metadata.documentType}/${timestamp}-${randomId}${extension}`;
  }

  /**
   * Get file signature (magic numbers) from buffer
   */
  private getFileSignature(file: Buffer): string {
    return file.slice(0, 8).toString('hex').toLowerCase();
  }

  /**
   * Validate file signature against MIME type
   */
  private isValidFileSignature(signature: string, mimeType: string): boolean {
    const signatures: Record<string, string[]> = {
      'application/pdf': ['255044462d'],
      'image/jpeg': ['ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2', 'ffd8ffe3', 'ffd8ffe8'],
      'image/png': ['89504e47'],
      'image/webp': ['52494646'],
      'application/msword': ['d0cf11e0'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['504b0304']
    };

    const validSignatures = signatures[mimeType];
    if (!validSignatures) return false;

    return validSignatures.some(validSig => signature.startsWith(validSig));
  }

  /**
   * Scan file for viruses (placeholder - integrate with actual AV service)
   */
  private async scanForViruses(file: Buffer): Promise<'clean' | 'infected' | 'error'> {
    // In production, integrate with AWS GuardDuty, ClamAV, or other AV service
    // For now, return 'clean' as placeholder
    try {
      // Placeholder virus scan logic
      // You would integrate with services like:
      // - AWS GuardDuty Malware Protection
      // - ClamAV
      // - VirusTotal API
      // - Third-party security services

      return 'clean';
    } catch (error) {
      console.error('Virus scan error:', error);
      return 'error';
    }
  }

  /**
   * Encrypt file content (placeholder - implement actual encryption)
   */
  private encryptFile(file: Buffer): Buffer {
    // In production, implement proper encryption
    // For now, return original file
    // You would use:
    // - AES-256 encryption
    // - AWS KMS for key management
    // - Proper IV generation

    return file;
  }

  /**
   * Download and decrypt verification document
   */
  async downloadDocument(documentId: string, requesterId: string): Promise<{
    success: boolean;
    fileBuffer?: Buffer;
    fileName?: string;
    mimeType?: string;
    error?: string;
  }> {
    try {
      await this.bucketReady;

      // Get document record
      const document = await prisma.verificationDocument.findUnique({
        where: { id: documentId },
        include: { lawyer: { include: { user: true } } }
      });

      if (!document) {
        return { success: false, error: 'Document not found' };
      }

      // Check permissions (lawyer can access their own documents, admins can access all)
      const hasPermission = await this.checkDownloadPermission(document, requesterId);
      if (!hasPermission) {
        return { success: false, error: 'Access denied' };
      }

      // Extract S3 key and bucket from URL
      const fileKey = this.extractFileKeyFromUrl(document.fileUrl);
      const bucket = this.extractBucketFromUrl(document.fileUrl) ?? this.resolveBucketName();

      // Download from S3
      const downloadParams: AWS.S3.GetObjectRequest = {
        Bucket: bucket,
        Key: fileKey
      };

      const s3Object = await this.s3.getObject(downloadParams).promise();
      let fileBuffer = s3Object.Body as Buffer;

      // Decrypt if needed
      const isEncrypted = s3Object.Metadata?.encrypted === 'true';
      if (isEncrypted) {
        fileBuffer = this.decryptFile(fileBuffer);
      }

      return {
        success: true,
        fileBuffer,
        fileName: document.fileName,
        mimeType: document.mimeType
      };

    } catch (error) {
      console.error('Document download error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Download failed'
      };
    }
  }

  /**
   * Check if user has permission to download document
   */
  private async checkDownloadPermission(document: any, requesterId: string): Promise<boolean> {
    // Check if requester is the document owner
    if (document.lawyer.userId === requesterId) {
      return true;
    }

    // Check if requester is an admin
    const requester = await prisma.user.findUnique({
      where: { id: requesterId }
    });

    return requester?.role === 'ADMIN';
  }

  /**
   * Extract S3 file key from URL
   */
  private extractFileKeyFromUrl(storageUrl: string): string {
    const url = new URL(storageUrl);
    return url.pathname.substring(1); // Remove leading slash
  }

  private extractBucketFromUrl(storageUrl: string): string | undefined {
    try {
      const url = new URL(storageUrl);
      const hostParts = url.hostname.split('.');
      if (hostParts.length > 0 && hostParts[0]) {
        return hostParts[0];
      }
    } catch (error) {
      console.error('Bucket extraction error:', error);
    }

    return undefined;
  }

  /**
   * Decrypt file content (placeholder)
   */
  private decryptFile(encryptedFile: Buffer): Buffer {
    // Implement actual decryption logic
    return encryptedFile;
  }

  /**
   * Delete verification document
   */
  async deleteDocument(documentId: string, requesterId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      await this.bucketReady;

      const document = await prisma.verificationDocument.findUnique({
        where: { id: documentId },
        include: { lawyer: { include: { user: true } } }
      });

      if (!document) {
        return { success: false, error: 'Document not found' };
      }

      // Check permissions
      const hasPermission = await this.checkDownloadPermission(document, requesterId);
      if (!hasPermission) {
        return { success: false, error: 'Access denied' };
      }

      // Delete from S3
      const fileKey = this.extractFileKeyFromUrl(document.fileUrl);
      const bucket = this.extractBucketFromUrl(document.fileUrl) ?? this.resolveBucketName();

      await this.s3.deleteObject({
        Bucket: bucket,
        Key: fileKey
      }).promise();

      // Delete from database
      await prisma.verificationDocument.delete({
        where: { id: documentId }
      });

      return { success: true };

    } catch (error) {
      console.error('Document deletion error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Deletion failed'
      };
    }
  }

  /**
   * Get upload requirements for document type
   */
  getUploadRequirements(documentType: VerificationDocumentType): {
    allowedFormats: string[];
    maxSize: string;
    description: string;
    required: boolean;
    expirationWarning?: string;
  } {
    const requirements = {
      [VerificationDocumentType.BAR_LICENSE]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Current bar license certificate from the state where you practice',
        required: true,
        expirationWarning: 'Please ensure your bar license is current and not expired'
      },
      [VerificationDocumentType.STATE_ID]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Government-issued photo ID (Driver\'s License, Passport, or State ID)',
        required: true
      },
      [VerificationDocumentType.INSURANCE_CERT]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Professional liability insurance certificate',
        required: false,
        expirationWarning: 'Insurance certificate should be current and valid'
      },
      [VerificationDocumentType.EDUCATION_DIPLOMA]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Law school diploma or degree certificate',
        required: false
      },
      [VerificationDocumentType.PROFESSIONAL_CERT]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Additional professional certifications or specializations',
        required: false
      },
      [VerificationDocumentType.OTHER]: {
        allowedFormats: ['PDF', 'JPEG', 'PNG'],
        maxSize: '10MB',
        description: 'Other relevant professional documents',
        required: false
      }
    };

    return requirements[documentType];
  }

  /**
   * Generate presigned URL for direct browser upload
   */
  async generatePresignedUploadUrl(
    lawyerId: string,
    documentType: VerificationDocumentType,
    fileName: string,
    mimeType: string
  ): Promise<{
    success: boolean;
    uploadUrl?: string;
    fileKey?: string;
    error?: string;
  }> {
    try {
      await this.bucketReady;

      // Validate MIME type
      if (!this.config.allowedMimeTypes.includes(mimeType)) {
        return {
          success: false,
          error: `File type ${mimeType} is not allowed`
        };
      }

      const fileKey = this.generateSecureFileKey({
        originalName: fileName,
        mimeType,
        fileSize: 0, // Will be validated on actual upload
        lawyerId,
        documentType,
        isRequired: true
      });

      const uploadParams = {
        Bucket: this.resolveBucketName(),
        Key: fileKey,
        ContentType: mimeType,
        Expires: 300, // 5 minutes
        Conditions: [
          ['content-length-range', 0, this.config.maxFileSize],
          ['starts-with', '$Content-Type', mimeType]
        ]
      };

      const uploadUrl = await this.s3.getSignedUrlPromise('putObject', uploadParams);

      return {
        success: true,
        uploadUrl,
        fileKey
      };

    } catch (error) {
      console.error('Presigned URL generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate upload URL'
      };
    }
  }
}

export default new DocumentUploadService();