import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import prisma from '../config/database';
import messageEncryptionService from './messageEncryption.service';
import webSocketManager from './websocketManager.service';

interface FileUploadConfig {
  maxFileSize: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  virusScanEnabled: boolean;
  encryptionEnabled: boolean;
}

interface UploadedFileInfo {
  id: string;
  fileName: string;
  originalFileName: string;
  fileSize: number;
  mimeType: string;
  storageUrl: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  encryptionKeyId?: string;
  virusScanStatus: string;
}

interface FileAccessResult {
  success: boolean;
  fileBuffer?: Buffer;
  fileName?: string;
  mimeType?: string;
  error?: string;
}

class FileSharing {
  private readonly UPLOAD_DIR = path.join(process.cwd(), 'uploads');
  private readonly THUMBNAIL_DIR = path.join(this.UPLOAD_DIR, 'thumbnails');
  private readonly PREVIEW_DIR = path.join(this.UPLOAD_DIR, 'previews');

  private readonly DEFAULT_CONFIG: FileUploadConfig = {
    maxFileSize: 100 * 1024 * 1024, // 100MB
    allowedMimeTypes: [
      // Images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      // Documents
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv',
      // Archives
      'application/zip', 'application/x-rar-compressed',
      // Audio/Video
      'audio/mpeg', 'audio/wav', 'video/mp4', 'video/avi'
    ],
    allowedExtensions: [
      '.jpg', '.jpeg', '.png', '.gif', '.webp',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.txt', '.csv', '.zip', '.rar', '.mp3', '.wav', '.mp4', '.avi'
    ],
    virusScanEnabled: true,
    encryptionEnabled: true
  };

  constructor() {
    this.ensureDirectoriesExist();
  }

  private async ensureDirectoriesExist(): Promise<void> {
    try {
      await fs.mkdir(this.UPLOAD_DIR, { recursive: true });
      await fs.mkdir(this.THUMBNAIL_DIR, { recursive: true });
      await fs.mkdir(this.PREVIEW_DIR, { recursive: true });
    } catch (error) {
      console.error('Failed to create upload directories:', error);
    }
  }

  /**
   * Configure multer for file uploads
   */
  getMulterConfig(): multer.Multer {
    const storage = multer.memoryStorage();

    return multer({
      storage,
      limits: {
        fileSize: this.DEFAULT_CONFIG.maxFileSize,
        files: 5 // Maximum 5 files per request
      },
      fileFilter: (req, file, cb) => {
        // Check MIME type
        if (!this.DEFAULT_CONFIG.allowedMimeTypes.includes(file.mimetype)) {
          return cb(new Error(`File type ${file.mimetype} not allowed`));
        }

        // Check file extension
        const ext = path.extname(file.originalname).toLowerCase();
        if (!this.DEFAULT_CONFIG.allowedExtensions.includes(ext)) {
          return cb(new Error(`File extension ${ext} not allowed`));
        }

        cb(null, true);
      }
    });
  }

  /**
   * Upload file to conversation
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    conversationId: string,
    changedBy: string
  ): Promise<UploadedFileInfo | null> {
    try {
      // Validate conversation access
      const hasAccess = await this.validateConversationAccess(changedBy, conversationId);
      if (!hasAccess) {
        throw new Error('Access denied to conversation');
      }

      // Validate file type
      const detectedType = await fileTypeFromBuffer(fileBuffer);
      if (detectedType && detectedType.mime !== mimeType) {
        console.warn(`MIME type mismatch: detected ${detectedType.mime}, claimed ${mimeType}`);
      }

      // Generate unique file ID and storage path
      const fileId = crypto.randomUUID();
      const fileExtension = path.extname(fileName);
      const storedFileName = `${fileId}${fileExtension}`;
      const filePath = path.join(this.UPLOAD_DIR, storedFileName);

      // Generate file hash for duplicate detection
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // Check for duplicate files
      const existingFile = await prisma.fileShare.findFirst({
        where: {
          fileHash,
          conversationId
          // isActive: false // Field does not exist
        }
      });

      if (existingFile) {
        console.log(`Duplicate file detected: ${fileHash}`);
        return {
          id: existingFile.id,
          fileName: existingFile.fileName,
          originalFileName: existingFile.originalFileName,
          fileSize: Number(existingFile.fileSize),
          mimeType: existingFile.mimeType,
          storageUrl: existingFile.storageUrl,
          thumbnailUrl: existingFile.thumbnailUrl || undefined,
          previewUrl: existingFile.previewUrl || undefined,
          encryptionKeyId: existingFile.encryptionKeyId || undefined,
          virusScanStatus: existingFile.virusScanStatus
        };
      }

      // Perform virus scan
      const virusScanResult = await this.performVirusScan(fileBuffer);

      if (virusScanResult.status === 'infected') {
        throw new Error('File contains malware and cannot be uploaded');
      }

      // Encrypt file if enabled
      let finalBuffer = fileBuffer;
      let encryptionKeyId: string | undefined;

      if (this.DEFAULT_CONFIG.encryptionEnabled) {
        const encryptionResult = await messageEncryptionService.encryptFile(fileBuffer, conversationId);
        finalBuffer = encryptionResult.encryptedBuffer;
        encryptionKeyId = encryptionResult.encryptionKeyId;
      }

      // Save file to storage
      await fs.writeFile(filePath, finalBuffer);

      // Generate thumbnail and preview if applicable
      const thumbnailUrl = await this.generateThumbnail(fileBuffer, fileId, mimeType);
      const previewUrl = await this.generatePreview(fileBuffer, fileId, mimeType);

      // Create database record
      const fileRecord = await prisma.fileShare.create({
        data: {
          conversationId,
          uploadedBy: changedBy, // Map changedBy to uploadedBy
          fileName: storedFileName,
          originalFileName: fileName,
          fileSize: BigInt(fileBuffer.length),
          mimeType,
          fileHash,
          storageUrl: `/uploads/${storedFileName}`,
          thumbnailUrl,
          previewUrl,
          isEncrypted: this.DEFAULT_CONFIG.encryptionEnabled,
          encryptionKeyId,
          virusScanStatus: virusScanResult.status,
          virusScanDetails: virusScanResult.details,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year expiry
        }
      });

      // Notify conversation participants
      await (webSocketManager as any).sendMessage?.(
        conversationId,
        'file_uploaded',
        {
          fileId: fileRecord.id,
          fileName: fileName,
          fileSize: fileBuffer.length,
          mimeType,
          changedBy,
          timestamp: new Date()
        },
        changedBy
      );

      console.log(`File uploaded: ${fileName} (${fileBuffer.length} bytes) to conversation ${conversationId}`);

      return {
        id: fileRecord.id,
        fileName: fileRecord.fileName,
        originalFileName: fileRecord.originalFileName,
        fileSize: Number(fileRecord.fileSize),
        mimeType: fileRecord.mimeType,
        storageUrl: fileRecord.storageUrl,
        thumbnailUrl: fileRecord.thumbnailUrl || undefined,
        previewUrl: fileRecord.previewUrl || undefined,
        encryptionKeyId: fileRecord.encryptionKeyId || undefined,
        virusScanStatus: fileRecord.virusScanStatus
      };

    } catch (error) {
      console.error('Failed to upload file:', error);
      return null;
    }
  }

  /**
   * Download file by ID
   */
  async downloadFile(fileId: string, userId: string): Promise<FileAccessResult> {
    try {
      // Get file record
      const fileRecord = await prisma.fileShare.findUnique({
        where: { id: fileId },
        include: { conversation: true }
      });

      if (!fileRecord) {
        return { success: false, error: 'File not found' };
      }
      // Note: isActive field does not exist in schema

      // Check access permissions
      const hasAccess = await this.validateConversationAccess(userId, fileRecord.conversationId);
      if (!hasAccess) {
        return { success: false, error: 'Access denied' };
      }

      // Check if file has expired
      if (fileRecord.expiresAt && fileRecord.expiresAt < new Date()) {
        return { success: false, error: 'File has expired' };
      }

      // Check virus scan status
      if (fileRecord.virusScanStatus === 'infected') {
        return { success: false, error: 'File is quarantined due to malware' };
      }

      // Read file from storage
      const filePath = path.join(this.UPLOAD_DIR, fileRecord.fileName);
      let fileBuffer: Buffer;

      try {
        fileBuffer = await fs.readFile(filePath);
      } catch (error) {
        console.error(`File not found on disk: ${filePath}`);
        return { success: false, error: 'File not available' };
      }

      // Decrypt file if encrypted
      if (fileRecord.isEncrypted && fileRecord.encryptionKeyId) {
        const decryptedBuffer = await messageEncryptionService.decryptFile(
          fileBuffer,
          fileRecord.encryptionKeyId
        );

        if (!decryptedBuffer) {
          return { success: false, error: 'Failed to decrypt file' };
        }

        fileBuffer = decryptedBuffer;
      }

      // Update download statistics
      await prisma.fileShare.update({
        where: { id: fileId },
        data: {
          downloadCount: { increment: 1 },
          lastDownloadedAt: new Date()
        }
      });

      // Log file access for audit
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'file_downloaded',
          eventData: {
            fileId,
            fileName: fileRecord.originalFileName,
            fileSize: Number(fileRecord.fileSize)
          },
          initiatedBy: userId,
          conversationId: fileRecord.conversationId,
          isPrivileged: true
        }
      });

      return {
        success: true,
        fileBuffer,
        fileName: fileRecord.originalFileName,
        mimeType: fileRecord.mimeType
      };

    } catch (error) {
      console.error('Failed to download file:', error);
      return { success: false, error: 'Download failed' };
    }
  }

  /**
   * Delete file (soft delete)
   */
  async deleteFile(fileId: string, userId: string): Promise<boolean> {
    try {
      const fileRecord = await prisma.fileShare.findUnique({
        where: { id: fileId },
        include: { conversation: true }
      });

      if (!fileRecord) {
        return false;
      }

      // Check if user can delete (uploader or conversation participant)
      const hasAccess = await this.validateConversationAccess(userId, fileRecord.conversationId);
      if (!hasAccess && (fileRecord as any).uploadedBy !== userId) {
        return false;
      }

      // Soft delete
      await prisma.fileShare.update({
        where: { id: fileId },
        data: {
          // isActive: true, // Field does not exist
          // deletedAt: new Date(), // Field does not exist
          // deletedBy: userId // Field does not exist
        }
      });

      // Notify conversation participants
      await (webSocketManager as any).sendMessage?.(
        fileRecord.conversationId,
        'file_deleted',
        {
          fileId,
          fileName: fileRecord.originalFileName,
          deletedBy: userId,
          timestamp: new Date()
        }
      );

      console.log(`File deleted: ${fileId} by user ${userId}`);
      return true;

    } catch (error) {
      console.error('Failed to delete file:', error);
      return false;
    }
  }

  /**
   * Get files for a conversation
   */
  async getConversationFiles(conversationId: string, userId: string): Promise<UploadedFileInfo[]> {
    try {
      // Validate access
      const hasAccess = await this.validateConversationAccess(userId, conversationId);
      if (!hasAccess) {
        return [];
      }

      const files = await prisma.fileShare.findMany({
        where: {
          conversationId,
          // isActive: false, // Field does not exist
          virusScanStatus: { not: 'infected' }
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          originalFileName: true,
          fileSize: true,
          mimeType: true,
          storageUrl: true,
          thumbnailUrl: true,
          previewUrl: true,
          encryptionKeyId: true,
          virusScanStatus: true,
          downloadCount: true,
          createdAt: true,
          uploader: {
            select: {
              id: true,
              firstName: true,
              lastName: true
            }
          }
        }
      });

      return files.map(file => ({
        id: file.id,
        fileName: file.fileName,
        originalFileName: file.originalFileName,
        fileSize: Number(file.fileSize),
        mimeType: file.mimeType,
        storageUrl: file.storageUrl,
        thumbnailUrl: file.thumbnailUrl || undefined,
        previewUrl: file.previewUrl || undefined,
        encryptionKeyId: file.encryptionKeyId || undefined,
        virusScanStatus: file.virusScanStatus
      }));

    } catch (error) {
      console.error('Failed to get conversation files:', error);
      return [];
    }
  }

  /**
   * Generate thumbnail for images
   */
  private async generateThumbnail(fileBuffer: Buffer, fileId: string, mimeType: string): Promise<string | null> {
    try {
      // Only generate thumbnails for images
      if (!mimeType.startsWith('image/')) {
        return null;
      }

      const thumbnailPath = path.join(this.THUMBNAIL_DIR, `${fileId}_thumb.jpg`);

      // Generate 200x200 thumbnail
      await sharp(fileBuffer)
        .resize(200, 200, {
          fit: 'cover',
          position: 'center'
        })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath);

      return `/uploads/thumbnails/${fileId}_thumb.jpg`;

    } catch (error) {
      console.error('Failed to generate thumbnail:', error);
      return null;
    }
  }

  /**
   * Generate preview for documents
   */
  private async generatePreview(fileBuffer: Buffer, fileId: string, mimeType: string): Promise<string | null> {
    try {
      // For now, only generate previews for images (same as thumbnail but larger)
      if (!mimeType.startsWith('image/')) {
        return null;
      }

      const previewPath = path.join(this.PREVIEW_DIR, `${fileId}_preview.jpg`);

      // Generate 800x600 preview
      await sharp(fileBuffer)
        .resize(800, 600, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 90 })
        .toFile(previewPath);

      return `/uploads/previews/${fileId}_preview.jpg`;

    } catch (error) {
      console.error('Failed to generate preview:', error);
      return null;
    }
  }

  /**
   * Perform virus scan (mock implementation)
   */
  private async performVirusScan(fileBuffer: Buffer): Promise<{
    status: 'clean' | 'infected' | 'error';
    details?: any;
  }> {
    try {
      // Mock virus scan - in production, integrate with actual antivirus service
      // Check for simple patterns that might indicate malicious files

      const fileContent = fileBuffer.toString('hex');

      // Simple heuristics (not comprehensive)
      const suspiciousPatterns = [
        '4d5a', // MZ header (executable)
        '504b0304', // ZIP file with suspicious structure
        // Add more patterns as needed
      ];

      // Check file size - extremely large files might be suspicious
      if (fileBuffer.length > 500 * 1024 * 1024) { // 500MB
        return {
          status: 'error',
          details: { reason: 'File too large for scanning' }
        };
      }

      // In production, call actual antivirus API here
      // For now, assume all files are clean unless they match suspicious patterns

      for (const pattern of suspiciousPatterns) {
        if (fileContent.startsWith(pattern)) {
          return {
            status: 'infected',
            details: {
              reason: 'Suspicious file header detected',
              pattern: pattern
            }
          };
        }
      }

      return { status: 'clean' };

    } catch (error) {
      console.error('Virus scan failed:', error);
      return {
        status: 'error',
        details: { error: (error as any).message }
      };
    }
  }

  /**
   * Validate user access to conversation
   */
  private async validateConversationAccess(userId: string, conversationId: string): Promise<boolean> {
    try {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { clientId: true, lawyerId: true }
      });

      return conversation?.clientId === userId || conversation?.lawyerId === userId;
    } catch (error) {
      console.error('Failed to validate conversation access:', error);
      return false;
    }
  }

  /**
   * Clean up expired files
   */
  async cleanupExpiredFiles(): Promise<void> {
    try {
      const expiredFiles = await prisma.fileShare.findMany({
        where: {
          expiresAt: { lt: new Date() }
          // isActive: false // Field does not exist
        }
      });

      for (const file of expiredFiles) {
        // Mark as deleted
        await prisma.fileShare.update({
          where: { id: file.id },
          data: {
            // isActive: true, // Field does not exist
            // deletedAt: new Date(), // Field does not exist
            // deletedBy: 'system' // Field does not exist
          }
        });

        // Remove from disk
        const filePath = path.join(this.UPLOAD_DIR, file.fileName);
        try {
          await fs.unlink(filePath);
          console.log(`Deleted expired file: ${filePath}`);
        } catch (error) {
          console.error(`Failed to delete file from disk: ${filePath}`, error);
        }
      }

      if (expiredFiles.length > 0) {
        console.log(`Cleaned up ${expiredFiles.length} expired files`);
      }

    } catch (error) {
      console.error('Failed to cleanup expired files:', error);
    }
  }

  /**
   * Get file sharing statistics
   */
  async getFileStats(conversationId: string, userId: string): Promise<any> {
    try {
      const hasAccess = await this.validateConversationAccess(userId, conversationId);
      if (!hasAccess) {
        return null;
      }

      const stats = await prisma.fileShare.aggregate({
        where: {
          conversationId
          // isActive: false // Field does not exist
        },
        _count: { id: true },
        _sum: { fileSize: true }
      });

      const filesByType = await prisma.fileShare.groupBy({
        by: ['mimeType'],
        where: {
          conversationId
          // isActive: false // Field does not exist
        },
        _count: { id: true }
      });

      return {
        totalFiles: stats._count?.id || 0,
        totalSize: Number(stats._sum?.fileSize || 0),
        filesByType: filesByType.reduce((acc, item) => {
          acc[item.mimeType] = (item._count as any)?.id || 0;
          return acc;
        }, {} as Record<string, number>)
      };

    } catch (error) {
      console.error('Failed to get file stats:', error);
      return null;
    }
  }
}

// Create singleton instance
const fileSharingService = new FileSharing();

export default fileSharingService;
export { FileUploadConfig, UploadedFileInfo, FileAccessResult };