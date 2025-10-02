import { Prisma, Document, DocumentType, DocumentCategory, SecurityLevel, DocumentStatus, WorkflowStatus } from '@prisma/client';
import AWS from 'aws-sdk';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { promisify } from 'util';
import sharp from 'sharp';
import { pipeline as streamPipeline } from 'stream/promises';
import prisma from '../config/database';

const unlinkAsync = promisify(fs.unlink);

interface DocumentUploadOptions {
  userId: string;
  folderId?: string;
  category?: DocumentCategory;
  securityLevel: SecurityLevel;
  description?: string;
  tags?: string[];
  isTemplate?: boolean;
  title?: string;
}

interface ProcessedDocument {
  id: string;
  fileName: string;
  storageUrl: string;
  thumbnailUrl?: string;
  extractedText?: string;
  fileSize: number;
  mimeType: string;
}

interface DocumentProcessingResult {
  success: boolean;
  document?: ProcessedDocument;
  error?: string;
  processingDetails: {
    virusScanPassed: boolean;
    ocrCompleted: boolean;
    thumbnailGenerated: boolean;
    textExtracted: boolean;
    encrypted: boolean;
  };
}

interface EncryptionResult {
  filePath: string;
  algorithm: string;
  iv: string;
}

class DocumentService {
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
   * Configure multer for secure file uploads with virus scanning
   */
  getMulterConfig() {
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), 'temp-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueId = crypto.randomUUID();
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${uniqueId}_${sanitizedName}`);
      }
    });

    const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
      // Define allowed file types for legal documents
      const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/tiff',
        'image/bmp',
        'application/rtf'
      ];

      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
    };

    return multer({
      storage,
      fileFilter,
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit
        files: 10 // Maximum 10 files per upload
      }
    });
  }

  /**
   * Process uploaded document with security scanning and content extraction
   */
  async processDocument(
    file: Express.Multer.File,
    options: DocumentUploadOptions
  ): Promise<DocumentProcessingResult> {
    const processingDetails = {
      virusScanPassed: false,
      ocrCompleted: false,
      thumbnailGenerated: false,
      textExtracted: false,
      encrypted: false
    };

    const sanitizedFileName = this.sanitizeFileName(file.originalname);
    const fileExtension = path.extname(file.originalname).toLowerCase();

    try {
      const virusScanResult = await this.performVirusScan(file.path);
      processingDetails.virusScanPassed = virusScanResult.clean;

      if (!virusScanResult.clean) {
        await this.cleanupTempFile(file.path);
        return {
          success: false,
          error: `Virus detected: ${virusScanResult.threat}`,
          processingDetails
        };
      }

      const fileChecksum = await this.generateFileChecksum(file.path);
      const duplicate = await this.findDuplicateDocument(file.originalname, file.size, options.userId);
      if (duplicate) {
        await this.cleanupTempFile(file.path);
        return {
          success: false,
          error: 'A document with the same name and size already exists',
          processingDetails
        };
      }

      let extractedText: string | undefined;
      try {
        extractedText = await this.extractTextContent(file);
        if (extractedText) {
          processingDetails.textExtracted = true;
        }
        processingDetails.ocrCompleted = this.requiresOCR(file.mimetype);
      } catch (error) {
        console.warn('Text extraction failed:', error);
      }

      let thumbnailPath: string | undefined;
      try {
        if (this.canGenerateThumbnail(file.mimetype)) {
          thumbnailPath = await this.generateThumbnail(file.path);
          processingDetails.thumbnailGenerated = true;
        }
      } catch (error) {
        console.warn('Thumbnail generation failed:', error);
      }

      let encryptionResult: EncryptionResult | undefined;
      if (this.shouldEncrypt(options.securityLevel)) {
        encryptionResult = await this.encryptFile(file.path);
        processingDetails.encrypted = true;
      }

      const fileToUpload = encryptionResult?.filePath ?? file.path;
      const s3Key = this.generateS3Key(options.userId, file.originalname, options.securityLevel);
      const storageUrl = await this.uploadToS3(fileToUpload, s3Key, file.mimetype);

      let thumbnailUrl: string | undefined;
      if (thumbnailPath) {
        const thumbnailKey = this.generateS3Key(options.userId, `thumb_${file.originalname}`, options.securityLevel, true);
        thumbnailUrl = await this.uploadToS3(thumbnailPath, thumbnailKey, 'image/jpeg');
      }

      const documentType = this.determineDocumentType(file.originalname, file.mimetype, extractedText);
      const autoCategory = options.category ?? this.determineDocumentCategory(file.originalname, extractedText);
      const title = options.title ?? this.deriveTitle(file.originalname);

      const metadata: Prisma.JsonObject = {
        checksum: fileChecksum,
        originalMimeType: file.mimetype,
        thumbnailGenerated: Boolean(thumbnailPath),
        uploadKey: s3Key
      };

      if (options.isTemplate) {
        metadata.isTemplate = true;
      }

      if (encryptionResult) {
        metadata.encryption = {
          algorithm: encryptionResult.algorithm,
          iv: encryptionResult.iv
        };
      }

      const document = await prisma.document.create({
        data: {
          fileName: sanitizedFileName,
          originalFileName: file.originalname,
          title,
          fileSize: BigInt(file.size),
          mimeType: file.mimetype,
          fileExtension,
          documentType,
          category: autoCategory,
          ownerId: options.userId,
          createdBy: options.userId,
          folderId: options.folderId,
          storageUrl,
          thumbnailUrl,
          extractedText,
          securityLevel: options.securityLevel,
          description: options.description,
          tags: options.tags && options.tags.length > 0 ? options.tags : undefined,
          documentMetadata: metadata,
          isEncrypted: Boolean(encryptionResult)
        }
      });

      await prisma.documentVersion.create({
        data: {
          documentId: document.id,
          versionNumber: 1,
          versionLabel: 'Initial',
          fileName: document.fileName,
          fileSize: document.fileSize,
          storageUrl: document.storageUrl,
          mimeType: document.mimeType,
          extractedText: document.extractedText,
          changedBy: options.userId,
          changeDescription: 'Initial upload',
          versionMetadata: {
            checksum: fileChecksum,
            uploadKey: s3Key
          }
        }
      });

      await this.cleanupTempFile(file.path);
      if (thumbnailPath) await this.cleanupTempFile(thumbnailPath);
      if (encryptionResult && encryptionResult.filePath !== file.path) {
        await this.cleanupTempFile(encryptionResult.filePath);
      }

      return {
        success: true,
        document: {
          id: document.id,
          fileName: document.fileName,
          storageUrl: document.storageUrl,
          thumbnailUrl: document.thumbnailUrl ?? undefined,
          extractedText: document.extractedText ?? undefined,
          fileSize: Number(document.fileSize),
          mimeType: document.mimeType
        },
        processingDetails
      };

    } catch (error) {
      console.error('Document processing failed:', error);
      await this.cleanupTempFile(file.path);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Document processing failed',
        processingDetails
      };
    }
  }

  /**
   * Perform virus scanning (integrate with ClamAV or similar service)
   */
  private async performVirusScan(filePath: string): Promise<{ clean: boolean; threat?: string }> {
    // Mock implementation - replace with actual virus scanning service
    // This would typically integrate with ClamAV, Windows Defender API, or cloud service

    try {
      // Simulate virus scanning delay
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Basic file size check (extremely large files might be suspicious)
      const stats = fs.statSync(filePath);
      if (stats.size > 500 * 1024 * 1024) { // 500MB
        return { clean: false, threat: 'File too large, potential zip bomb' };
      }

      // Check for suspicious file extensions in disguise
      const content = fs.readFileSync(filePath);
      const fileHeader = content.slice(0, 10).toString('hex');

      // Basic header validation
      if (this.isSuspiciousFileHeader(fileHeader)) {
        return { clean: false, threat: 'Suspicious file header detected' };
      }

      return { clean: true };

    } catch (error) {
      console.error('Virus scan failed:', error);
      return { clean: false, threat: 'Virus scan failed' };
    }
  }

  /**
   * Check if file header indicates suspicious content
   */
  private isSuspiciousFileHeader(header: string): boolean {
    // Basic checks for known malicious patterns
    const suspiciousHeaders = [
      '4d5a', // PE executable
      '7f454c46', // ELF executable
      'cafebabe', // Java class file
    ];

    return suspiciousHeaders.some(pattern => header.startsWith(pattern));
  }

  /**
   * Generate SHA-256 checksum for file integrity
   */
  private async generateFileChecksum(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Check for duplicate documents by filename and size
   */
  private async findDuplicateDocument(originalFileName: string, fileSize: number, userId: string): Promise<Document | null> {
    return prisma.document.findFirst({
      where: {
        originalFileName,
        fileSize: BigInt(fileSize),
        ownerId: userId,
        status: { not: DocumentStatus.DELETED },
        workflowStatus: { not: WorkflowStatus.DRAFT }
      }
    });
  }

  /**
   * Extract text content from various document types
   */
  private async extractTextContent(file: Express.Multer.File): Promise<string | undefined> {
    const { mimetype, path: filePath } = file;

    try {
      if (mimetype === 'application/pdf') {
        return this.extractTextFromPDF(filePath);
      } else if (mimetype.startsWith('image/')) {
        return this.extractTextFromImage(filePath);
      } else if (mimetype.includes('word') || mimetype.includes('document')) {
        return this.extractTextFromWord(filePath);
      } else if (mimetype === 'text/plain') {
        return fs.readFileSync(filePath, 'utf-8');
      }

      return undefined;
    } catch (error) {
      console.error('Text extraction failed:', error);
      return undefined;
    }
  }

  /**
   * Extract text from PDF using pdf-parse
   */
  private async extractTextFromPDF(filePath: string): Promise<string> {
    // This would typically use a library like pdf-parse
    // For now, return a placeholder
    return 'PDF text extraction not implemented yet';
  }

  /**
   * Extract text from images using OCR (Tesseract)
   */
  private async extractTextFromImage(filePath: string): Promise<string> {
    // This would typically use Tesseract.js or similar OCR service
    // For now, return a placeholder
    return 'OCR text extraction not implemented yet';
  }

  /**
   * Extract text from Word documents
   */
  private async extractTextFromWord(filePath: string): Promise<string> {
    // This would typically use mammoth.js or similar library
    // For now, return a placeholder
    return 'Word document text extraction not implemented yet';
  }

  /**
   * Generate thumbnail for visual documents
   */
  private async generateThumbnail(filePath: string): Promise<string> {
    const thumbnailPath = `${filePath}_thumbnail.jpg`;

    await sharp(filePath)
      .resize(300, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);

    return thumbnailPath;
  }

  /**
   * Check if file type can generate thumbnails
   */
  private canGenerateThumbnail(mimeType: string): boolean {
    return mimeType.startsWith('image/') || mimeType === 'application/pdf';
  }

  /**
   * Check if file type requires OCR
   */
  private requiresOCR(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  /**
   * Encrypt file for confidential documents
   */
  private async encryptFile(filePath: string): Promise<EncryptionResult> {
    const encryptedPath = `${filePath}.encrypted`;
    const algorithm = 'aes-256-cbc';
    const keySeed = process.env.DOCUMENT_ENCRYPTION_KEY || 'default-key';
    const key = crypto.createHash('sha256').update(keySeed).digest();
    const iv = crypto.randomBytes(16);

    const input = fs.createReadStream(filePath);
    const output = fs.createWriteStream(encryptedPath);
    output.write(iv);

    const cipher = crypto.createCipheriv(algorithm, key, iv);

    await streamPipeline(input, cipher, output);

    return {
      filePath: encryptedPath,
      algorithm,
      iv: iv.toString('hex')
    };
  }

  private shouldEncrypt(securityLevel: SecurityLevel): boolean {
    return (
      securityLevel === SecurityLevel.CONFIDENTIAL ||
      securityLevel === SecurityLevel.RESTRICTED ||
      securityLevel === SecurityLevel.TOP_SECRET
    );
  }

  private deriveTitle(fileName: string): string {
    const baseName = path.basename(fileName, path.extname(fileName));
    const cleaned = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned : 'Untitled Document';
  }

  /**
   * Generate S3 key with proper folder structure
   */
  private generateS3Key(
    userId: string,
    fileName: string,
    securityLevel: SecurityLevel,
    isThumbnail: boolean = false
  ): string {
    const timestamp = new Date().toISOString().split('T')[0];
    const uuid = crypto.randomUUID();
    const sanitizedName = this.sanitizeFileName(fileName);
    const folder = isThumbnail ? 'thumbnails' : 'documents';
    const securityFolder = securityLevel.toLowerCase();

    return `${folder}/${securityFolder}/${userId}/${timestamp}/${uuid}_${sanitizedName}`;
  }

  /**
   * Upload file to S3 with proper security settings
   */
  private async uploadToS3(filePath: string, key: string, contentType: string): Promise<string> {
    const fileStream = fs.createReadStream(filePath);

    const params = {
      Bucket: this.bucketName,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
      Metadata: {
        uploadedAt: new Date().toISOString(),
        changedBy: 'document-service'
      }
    };

    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  /**
   * Determine document type using filename, mime type, and extracted content
   */
  private determineDocumentType(fileName: string, mimeType: string, extractedText?: string): DocumentType {
    const lowerName = fileName.toLowerCase();
    const content = (extractedText ?? '').toLowerCase();
    const includes = (...keywords: string[]) => keywords.some(keyword => lowerName.includes(keyword) || content.includes(keyword));

    if (includes('agreement')) return DocumentType.AGREEMENT;
    if (includes('contract')) return DocumentType.CONTRACT;
    if (includes('motion')) return DocumentType.MOTION;
    if (includes('brief')) return DocumentType.BRIEF;
    if (includes('correspondence', 'letter', 'email')) return DocumentType.CORRESPONDENCE;
    if (includes('filing', 'petition', 'court')) return DocumentType.COURT_FILING;
    if (includes('evidence', 'exhibit')) return DocumentType.EVIDENCE;
    if (includes('opinion')) return DocumentType.LEGAL_OPINION;
    if (includes('memo', 'memorandum')) return DocumentType.MEMO;
    if (includes('invoice', 'billing')) return DocumentType.INVOICE;
    if (includes('receipt')) return DocumentType.RECEIPT;
    if (includes('form', 'application')) return DocumentType.FORM;
    if (includes('report', 'analysis', 'summary')) return DocumentType.REPORT;

    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
      return DocumentType.REPORT;
    }

    return DocumentType.OTHER;
  }

  /**
   * Automatically determine document category based on filename and content
   */
  private determineDocumentCategory(fileName: string, extractedText?: string): DocumentCategory {
    const lowerName = fileName.toLowerCase();
    const content = (extractedText ?? '').toLowerCase();
    const includes = (...keywords: string[]) => keywords.some(keyword => lowerName.includes(keyword) || content.includes(keyword));

    if (includes('client')) return DocumentCategory.CLIENT_FILE;
    if (includes('filing', 'petition', 'court')) return DocumentCategory.COURT_FILING;
    if (includes('letter', 'email', 'correspondence')) return DocumentCategory.CORRESPONDENCE;
    if (includes('evidence', 'exhibit')) return DocumentCategory.EVIDENCE;
    if (includes('invoice', 'billing', 'receipt')) return DocumentCategory.FINANCIAL;
    if (includes('template')) return DocumentCategory.TEMPLATE;
    if (includes('draft')) return DocumentCategory.DRAFT;
    if (includes('final')) return DocumentCategory.FINAL;
    if (includes('policy', 'procedure', 'administrative')) return DocumentCategory.ADMINISTRATIVE;

    return DocumentCategory.LEGAL_DOCUMENT;
  }

  /**
   * Sanitize filename for safe storage
   */
  private sanitizeFileName(fileName: string): string {
    return fileName
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Clean up temporary files
   */
  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        await unlinkAsync(filePath);
      }
    } catch (error) {
      console.error('Failed to cleanup temp file:', filePath, error);
    }
  }

  /**
   * Get document by ID with access control
   */
  async getDocument(documentId: string, userId: string): Promise<Document | null> {
    return prisma.document.findFirst({
      where: {
        id: documentId,
        status: { not: DocumentStatus.DELETED },
        workflowStatus: { not: WorkflowStatus.DRAFT },
        OR: [
          { ownerId: userId },
          {
            shares: {
              some: {
                sharedWith: userId,
                isActive: true,
                OR: [
                  { expiresAt: null },
                  { expiresAt: { gt: new Date() } }
                ]
              }
            }
          }
        ]
      },
      include: {
        folder: true,
        owner: {
          select: { id: true, firstName: true, lastName: true }
        },
        creator: {
          select: { id: true, firstName: true, lastName: true }
        },
        versionHistory: {
          orderBy: { versionNumber: 'desc' },
          take: 1
        }
      }
    });
  }

  /**
   * Delete document (soft delete with retention policy)
   */
  async deleteDocument(documentId: string, userId: string): Promise<boolean> {
    try {
      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          ownerId: userId,
          status: { not: DocumentStatus.DELETED }
        }
      });

      if (!document) {
        return false;
      }

      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: DocumentStatus.DELETED,
          workflowStatus: WorkflowStatus.ARCHIVED,
          deletedAt: new Date()
        }
      });

      return true;
    } catch (error) {
      console.error('Failed to delete document:', error);
      return false;
    }
  }
}

export default new DocumentService();
export { DocumentService, DocumentUploadOptions, ProcessedDocument, DocumentProcessingResult };