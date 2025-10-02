import { AccessLevel, ChangeType, Document, DocumentVersion, Prisma } from '@prisma/client';
import AWS from 'aws-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { promisify } from 'util';
import prisma from '../config/database';

const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);

type DocumentWithLatestVersion = Document & { versionHistory: DocumentVersion[] };
type VersionWithUser = DocumentVersion & {
  changedByUser: {
    id: string;
    firstName: string;
    lastName: string;
  };
};

interface CreateVersionOptions {
  documentId: string;
  userId: string;
  file: Express.Multer.File;
  changeNotes: string;
  isMinorChange?: boolean;
  extractedText?: string;
}

interface VersionComparison {
  fromVersion: number;
  toVersion: number;
  changes: {
    type: 'addition' | 'deletion' | 'modification';
    line: number;
    oldContent?: string;
    newContent?: string;
    context: string;
  }[];
  similarity: number;
  wordCount: {
    added: number;
    removed: number;
    unchanged: number;
  };
}

interface VersionMetrics {
  totalVersions: number;
  totalSize: number;
  averageVersionSize: number;
  versionFrequency: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  majorVersions: number;
  minorVersions: number;
  contributors: Array<{
    userId: string;
    userName: string;
    versionCount: number;
    lastContribution: Date;
  }>;
}

interface RollbackOptions {
  documentId: string;
  targetVersionNumber: number;
  userId: string;
  reason: string;
  createBackup?: boolean;
}

class VersionControlService {
  private s3: AWS.S3;
  private bucketName: string;

  constructor() {
    this.s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1'
    });
    this.bucketName = process.env.AWS_S3_BUCKET || 'lawyer-consultation-docs';
  }

  async createVersion(options: CreateVersionOptions): Promise<DocumentVersion | null> {
    try {
      const document = await this.ensureDocumentForUser(options.documentId, options.userId, true);
      const latestVersion = document.versionHistory[0] ?? null;
      const newVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;

      const extractedText = options.extractedText ?? await this.generateFileChecksum(options.file.path);

      if (latestVersion?.extractedText && latestVersion.extractedText === extractedText) {
        throw new Error('No changes detected - file matches the latest version');
      }

      const s3Key = this.generateVersionS3Key(options.documentId, newVersionNumber, options.file.originalname);
      const storageUrl = await this.uploadVersionToS3(options.file.path, s3Key, options.file.mimetype);

  let changeType: ChangeType = ChangeType.MODIFICATION;
      if (!latestVersion) {
        changeType = ChangeType.CREATION;
      } else if (options.isMinorChange) {
        changeType = ChangeType.MINOR_REVISION;
      } else {
        changeType = ChangeType.MAJOR_REVISION;
      }

      let diff: VersionComparison | null = null;
      if (latestVersion?.extractedText) {
        diff = await this.compareVersions(latestVersion.extractedText, extractedText);
        diff.fromVersion = latestVersion.versionNumber;
        diff.toVersion = newVersionNumber;
      }

      const diffPayload = diff ? (diff as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;

      const createdVersion = await prisma.$transaction(async (tx) => {
        const version = await tx.documentVersion.create({
          data: {
            documentId: options.documentId,
            versionNumber: newVersionNumber,
            versionLabel: `v${newVersionNumber}`,
            versionNotes: options.changeNotes,
            fileName: options.file.originalname,
            fileSize: BigInt(options.file.size),
            storageUrl,
            mimeType: options.file.mimetype,
            title: document.title,
            extractedText,
            versionMetadata: {
              uploadFileName: options.file.originalname,
              uploadMimeType: options.file.mimetype,
              uploadSize: options.file.size,
              uploadedBy: options.userId,
              uploadedAt: new Date().toISOString()
            },
            changeType,
            changedBy: options.userId,
            changeDescription: options.changeNotes,
            diffFromPrevious: diffPayload,
            isActive: true
          }
        });

        await tx.document.update({
          where: { id: options.documentId },
          data: {
            fileName: options.file.originalname,
            originalFileName: options.file.originalname,
            fileSize: BigInt(options.file.size),
            mimeType: options.file.mimetype,
            storageUrl,
            extractedText,
            currentVersion: newVersionNumber,
            isLatestVersion: true,
            lastAccessedBy: options.userId,
            lastAccessedAt: new Date()
          }
        });

        await tx.documentVersion.updateMany({
          where: {
            documentId: options.documentId,
            id: { not: version.id }
          },
          data: { isActive: false }
        });

        return version;
      });

      await this.cleanupTempFile(options.file.path);
      await this.archiveOldVersions(options.documentId);

      return createdVersion;
    } catch (error) {
      console.error('Failed to create version:', error);
      await this.cleanupTempFile(options.file.path);
      return null;
    }
  }

  async getVersionHistory(
    documentId: string,
    userId: string,
    limit = 20,
    offset = 0
  ): Promise<{
    versions: Array<VersionWithUser & { comparison?: VersionComparison }>;
    totalVersions: number;
    metrics: VersionMetrics;
  }> {
    await this.ensureDocumentForUser(documentId, userId, false);

    const versions = await prisma.documentVersion.findMany({
      where: { documentId },
      include: {
        changedByUser: {
          select: { id: true, firstName: true, lastName: true }
        }
      },
      orderBy: { versionNumber: 'desc' },
      take: limit,
      skip: offset
    });

    const enriched: Array<VersionWithUser & { comparison?: VersionComparison }> = [];
    for (let i = 0; i < versions.length; i += 1) {
      const current = versions[i];
      const previous = versions[i + 1];
      let comparison: VersionComparison | undefined;

      if (current.extractedText && previous?.extractedText) {
        comparison = await this.compareVersions(previous.extractedText, current.extractedText);
        comparison.fromVersion = previous.versionNumber;
        comparison.toVersion = current.versionNumber;
      }

      enriched.push({ ...current, comparison });
    }

    const totalVersions = await prisma.documentVersion.count({ where: { documentId } });
    const metrics = await this.calculateVersionMetrics(documentId);

    return {
      versions: enriched,
      totalVersions,
      metrics
    };
  }

  async rollbackToVersion(options: RollbackOptions): Promise<boolean> {
    const document = await this.ensureDocumentForUser(options.documentId, options.userId, true);

    const targetVersion = await prisma.documentVersion.findFirst({
      where: {
        documentId: options.documentId,
        versionNumber: options.targetVersionNumber
      }
    });

    if (!targetVersion) {
      throw new Error('Target version not found');
    }

    const latestVersionNumber = document.versionHistory[0]?.versionNumber ?? 0;

    await prisma.$transaction(async (tx) => {
      if (options.createBackup && latestVersionNumber > 0) {
        const backupVersionNumber = latestVersionNumber + 1;
        let backupUrl = document.storageUrl;

        const backupKey = this.generateVersionS3Key(options.documentId, backupVersionNumber, document.fileName);
        const copied = await this.copyObjectIfNeeded(document.storageUrl, backupKey);
        if (copied) {
          backupUrl = copied;
        }

        await tx.documentVersion.create({
          data: {
            documentId: options.documentId,
            versionNumber: backupVersionNumber,
            versionLabel: `v${backupVersionNumber} (backup)` ,
            versionNotes: `Backup before rollback: ${options.reason}`,
            fileName: document.fileName,
            fileSize: document.fileSize,
            storageUrl: backupUrl ?? document.storageUrl,
            mimeType: document.mimeType,
            title: document.title,
            extractedText: document.extractedText,
            versionMetadata: {
              createdFromVersion: latestVersionNumber,
              reason: options.reason,
              createdAt: new Date().toISOString()
            },
            changeType: ChangeType.ROLLBACK,
            changedBy: options.userId,
            changeDescription: options.reason,
            diffFromPrevious: Prisma.JsonNull,
            isActive: false
          }
        });
      }

      await tx.document.update({
        where: { id: options.documentId },
        data: {
          fileName: targetVersion.fileName,
          originalFileName: targetVersion.fileName,
          fileSize: targetVersion.fileSize,
          mimeType: targetVersion.mimeType,
          storageUrl: targetVersion.storageUrl,
          extractedText: targetVersion.extractedText,
          currentVersion: targetVersion.versionNumber,
          lastAccessedBy: options.userId,
          lastAccessedAt: new Date()
        }
      });

      await tx.documentVersion.updateMany({
        where: { documentId: options.documentId },
        data: { isActive: false }
      });

      await tx.documentVersion.update({
        where: { id: targetVersion.id },
        data: { isActive: true }
      });
    });

    return true;
  }

  private async ensureDocumentForUser(
    documentId: string,
    userId: string,
    requireWriteAccess: boolean
  ): Promise<DocumentWithLatestVersion> {
    const shareFilter = this.buildShareAccessFilter(userId, requireWriteAccess);

    const document = await prisma.document.findFirst({
      where: {
        id: documentId,
        deletedAt: null,
        OR: [
          { ownerId: userId },
          shareFilter
        ]
      },
      include: {
        versionHistory: {
          orderBy: { versionNumber: 'desc' },
          take: 1
        }
      }
    });

    if (!document) {
      throw new Error('Document not found or insufficient permissions');
    }

    return document as DocumentWithLatestVersion;
  }

  private buildShareAccessFilter(userId: string, requireWriteAccess: boolean) {
    const allowedLevels = requireWriteAccess
      ? [AccessLevel.EDIT, AccessLevel.FULL_ACCESS, AccessLevel.OWNER]
      : [
        AccessLevel.READ,
        AccessLevel.COMMENT,
        AccessLevel.EDIT,
        AccessLevel.FULL_ACCESS,
        AccessLevel.OWNER
      ];

    return {
      shares: {
        some: {
          sharedWith: userId,
          isActive: true,
          accessLevel: { in: allowedLevels }
        }
      }
    };
  }

  private async archiveOldVersions(documentId: string, keepActive = 50): Promise<void> {
    const versions = await prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
      skip: keepActive
    });

    if (versions.length === 0) {
      return;
    }

    await prisma.documentVersion.updateMany({
      where: { id: { in: versions.map((version) => version.id) } },
      data: { isActive: false }
    });
  }

  private async calculateVersionMetrics(documentId: string): Promise<VersionMetrics> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalVersions, totalSizeAgg, dailyCount, weeklyCount, monthlyCount, contributorStats, majorCount, minorCount] = await Promise.all([
      prisma.documentVersion.count({ where: { documentId } }),
      prisma.documentVersion.aggregate({
        where: { documentId },
        _sum: { fileSize: true }
      }),
      prisma.documentVersion.count({
        where: { documentId, createdAt: { gte: oneDayAgo } }
      }),
      prisma.documentVersion.count({
        where: { documentId, createdAt: { gte: oneWeekAgo } }
      }),
      prisma.documentVersion.count({
        where: { documentId, createdAt: { gte: oneMonthAgo } }
      }),
      prisma.documentVersion.groupBy({
        where: { documentId },
        by: ['changedBy'],
        _count: { _all: true },
        _max: { createdAt: true }
      }),
      prisma.documentVersion.count({
        where: {
          documentId,
          changeType: {
            in: [ChangeType.MAJOR_REVISION, ChangeType.MERGE, ChangeType.ROLLBACK]
          }
        }
      }),
      prisma.documentVersion.count({
        where: { documentId, changeType: ChangeType.MINOR_REVISION }
      })
    ]);

    const totalSize = Number(totalSizeAgg._sum.fileSize ?? 0n);
    const averageVersionSize = totalVersions > 0 ? totalSize / totalVersions : 0;

    const contributorIds = contributorStats.map((stat) => stat.changedBy);
    const contributorUsers = contributorIds.length
      ? await prisma.user.findMany({
        where: { id: { in: contributorIds } },
        select: { id: true, firstName: true, lastName: true }
      })
      : [];

    const contributors = contributorStats.map((stat) => {
      const user = contributorUsers.find((u) => u.id === stat.changedBy);
      const fullName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

      return {
        userId: stat.changedBy,
        userName: fullName.length ? fullName : user?.id ?? 'Unknown user',
        versionCount: stat._count._all,
        lastContribution: stat._max.createdAt ?? now
      };
    }).sort((a, b) => b.versionCount - a.versionCount);

    return {
      totalVersions,
      totalSize,
      averageVersionSize,
      versionFrequency: {
        daily: dailyCount,
        weekly: weeklyCount,
        monthly: monthlyCount
      },
      majorVersions: majorCount,
      minorVersions: minorCount,
      contributors
    };
  }

  async compareVersions(oldText: string, newText: string): Promise<VersionComparison> {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    const changes: VersionComparison['changes'] = [];
    let addedWords = 0;
    let removedWords = 0;
    let unchangedWords = 0;

    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i += 1) {
      const oldLine = oldLines[i] ?? '';
      const newLine = newLines[i] ?? '';

      if (oldLine !== newLine) {
        if (!oldLine) {
          changes.push({
            type: 'addition',
            line: i + 1,
            newContent: newLine,
            context: this.getLineContext(newLines, i)
          });
          addedWords += newLine.split(/\s+/).filter(Boolean).length;
        } else if (!newLine) {
          changes.push({
            type: 'deletion',
            line: i + 1,
            oldContent: oldLine,
            context: this.getLineContext(oldLines, i)
          });
          removedWords += oldLine.split(/\s+/).filter(Boolean).length;
        } else {
          changes.push({
            type: 'modification',
            line: i + 1,
            oldContent: oldLine,
            newContent: newLine,
            context: this.getLineContext(newLines, i)
          });

          removedWords += oldLine.split(/\s+/).filter(Boolean).length;
          addedWords += newLine.split(/\s+/).filter(Boolean).length;
        }
      } else {
        unchangedWords += oldLine.split(/\s+/).filter(Boolean).length;
      }
    }

    const totalWords = addedWords + removedWords + unchangedWords;
    const similarity = totalWords > 0 ? unchangedWords / totalWords : 1;

    return {
      fromVersion: 0,
      toVersion: 0,
      changes,
      similarity,
      wordCount: {
        added: addedWords,
        removed: removedWords,
        unchanged: unchangedWords
      }
    };
  }

  private getLineContext(lines: string[], index: number, radius: number = 2): string {
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    return lines.slice(start, end).join('\n');
  }

  private async uploadVersionToS3(filePath: string, key: string, contentType: string): Promise<string> {
    const fileContent = await readFileAsync(filePath);

    await this.s3.putObject({
      Bucket: this.bucketName,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
      ACL: 'private'
    }).promise();

    const region = process.env.AWS_REGION || 'us-east-1';
    return `https://${this.bucketName}.s3.${region}.amazonaws.com/${key}`;
  }

  private generateVersionS3Key(documentId: string, versionNumber: number, originalName: string): string {
    const extension = path.extname(originalName);
    const basename = path.basename(originalName, extension);
    const sanitized = this.sanitizeFileName(basename);
    return `documents/${documentId}/versions/v${versionNumber}-${Date.now()}-${sanitized}${extension}`;
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await unlinkAsync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Failed to remove temporary file ${filePath}:`, error);
      }
    }
  }

  private async generateFileChecksum(filePath: string): Promise<string> {
    const fileBuffer = await readFileAsync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  private extractS3KeyFromUrl(url: string | null | undefined): string | null {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    } catch (error) {
      console.warn('Unable to parse S3 URL:', url, error);
      return null;
    }
  }

  private async copyObjectIfNeeded(sourceUrl: string | null | undefined, destinationKey: string): Promise<string | null> {
    const sourceKey = this.extractS3KeyFromUrl(sourceUrl);
    if (!sourceKey) {
      return null;
    }

    try {
      await this.s3.copyObject({
        Bucket: this.bucketName,
        CopySource: `/${this.bucketName}/${sourceKey}`,
        Key: destinationKey,
        ACL: 'private'
      }).promise();

      const region = process.env.AWS_REGION || 'us-east-1';
      return `https://${this.bucketName}.s3.${region}.amazonaws.com/${destinationKey}`;
    } catch (error) {
      console.warn('Failed to copy S3 object for backup:', error);
      return null;
    }
  }
}

const versionControlService = new VersionControlService();

export default versionControlService;
export { VersionControlService };