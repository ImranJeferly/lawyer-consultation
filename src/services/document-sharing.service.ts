import { DocumentShare, AccessLevel, Document, SecurityLevel, ShareType } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../config/database';
import firebaseService from './firebase.service';

interface ShareDocumentOptions {
  documentId: string;
  ownerId: string;
  sharedWithUserId?: string;
  sharedWithEmail?: string;
  accessLevel: AccessLevel;
  expiresAt?: Date | null;
  requiresPassword?: boolean;
  password?: string;
  allowDownload?: boolean;
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowReshare?: boolean;
  notifyOnAccess?: boolean;
}

interface CreateShareLinkOptions {
  documentId: string;
  ownerId: string;
  accessLevel: AccessLevel;
  expiresAt?: Date | null;
  maxAccessCount?: number | null;
  requiresPassword?: boolean;
  password?: string;
  notifyOnAccess?: boolean;
}

interface SharePermissions {
  canView: boolean;
  canEdit: boolean;
  canComment: boolean;
  canShare: boolean;
  canDownload: boolean;
  canPrint: boolean;
  canCopy: boolean;
  expiresAt?: Date;
  isOwner: boolean;
}

interface ShareAnalytics {
  totalShares: number;
  activeShares: number;
  expiredShares: number;
  revokedShares: number;
  viewsByAccessLevel: Record<AccessLevel, number>;
  sharesByUser: Array<{
    userId: string;
    userName: string;
    shareCount: number;
    lastShared: Date;
  }>;
  recentActivity: Array<{
    action: string;
    userId: string;
    userName: string;
    timestamp: Date;
    details: Record<string, unknown>;
  }>;
}

interface UpdateShareOptions {
  accessLevel?: AccessLevel;
  expiresAt?: Date | null;
  allowDownload?: boolean;
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowReshare?: boolean;
  requiresPassword?: boolean;
  password?: string | null;
  maxAccessCount?: number | null;
  notifyOnAccess?: boolean;
}

class DocumentSharingService {
  async shareDocument(options: ShareDocumentOptions): Promise<DocumentShare | null> {
    try {
      const document = await this.verifyOwnership(options.documentId, options.ownerId);
      if (!document) {
        throw new Error('Document not found or insufficient permissions');
      }

      let sharedWithUserId = options.sharedWithUserId ?? null;
      let sharedWithEmail = options.sharedWithEmail ?? null;

      if (sharedWithEmail && !sharedWithUserId) {
        const user = await prisma.user.findUnique({ where: { email: sharedWithEmail } });
        if (user) {
          sharedWithUserId = user.id;
          sharedWithEmail = null;
        }
      }

      if (!sharedWithUserId && !sharedWithEmail) {
        throw new Error('A recipient must be provided when sharing a document');
      }

      if (options.requiresPassword && !options.password) {
        throw new Error('Password is required when the share mandates a password');
      }

      const existingShare = await prisma.documentShare.findFirst({
        where: {
          documentId: options.documentId,
          isActive: true,
          ...(sharedWithUserId ? { sharedWith: sharedWithUserId } : {}),
          ...(sharedWithEmail ? { sharedWithEmail } : {})
        }
      });

      if (existingShare) {
        return this.updateShare(existingShare.id, {
          accessLevel: options.accessLevel,
          expiresAt: options.expiresAt ?? null,
          allowDownload: options.allowDownload,
          allowPrint: options.allowPrint,
          allowCopy: options.allowCopy,
          allowReshare: options.allowReshare,
          requiresPassword: options.requiresPassword,
          password: options.password ?? null,
          notifyOnAccess: options.notifyOnAccess
        });
      }

      this.validateAccessLevel(document.securityLevel, options.accessLevel);

      const shareToken = this.generateShareToken();
      const hashedPassword = options.password ? await this.hashPassword(options.password) : null;

      const share = await prisma.documentShare.create({
        data: {
          documentId: options.documentId,
          sharedBy: options.ownerId,
          sharedWith: sharedWithUserId,
          sharedWithEmail,
          shareType: ShareType.DIRECT,
          accessLevel: options.accessLevel,
          shareToken,
          requiresPassword: !!options.requiresPassword,
          sharePassword: hashedPassword,
          expiresAt: options.expiresAt ?? null,
          canDownload: options.allowDownload ?? true,
          canPrint: options.allowPrint ?? true,
          canCopy: options.allowCopy ?? true,
          canShare: options.allowReshare ?? false,
          notifyOnAccess: options.notifyOnAccess ?? false
        },
        include: {
          document: {
            select: { id: true, fileName: true, ownerId: true }
          },
          sharer: {
            select: { id: true, firstName: true, lastName: true, email: true }
          },
          recipient: {
            select: { id: true, firstName: true, lastName: true, email: true }
          }
        }
      });

      await this.sendShareNotification(share);
      await this.logShareAction({
        shareId: share.id,
        action: 'DOCUMENT_SHARED',
        userId: options.ownerId,
        details: {
          documentId: options.documentId,
          sharedWith: sharedWithUserId ?? sharedWithEmail,
          accessLevel: options.accessLevel
        }
      });

      return share;
    } catch (error) {
      console.error('Failed to share document:', error);
      return null;
    }
  }

  async createShareLink(options: CreateShareLinkOptions): Promise<{ shareLink: string; shareToken: string } | null> {
    try {
      const document = await this.verifyOwnership(options.documentId, options.ownerId);
      if (!document) {
        throw new Error('Document not found or insufficient permissions');
      }

      this.validateAccessLevel(document.securityLevel, options.accessLevel);

      const shareToken = this.generateShareToken();
      const hashedPassword = options.password ? await this.hashPassword(options.password) : null;

      await prisma.documentShare.create({
        data: {
          documentId: options.documentId,
          sharedBy: options.ownerId,
          shareType: ShareType.LINK,
          accessLevel: options.accessLevel,
          shareToken,
          expiresAt: options.expiresAt ?? null,
          maxAccessCount: options.maxAccessCount ?? null,
          requiresPassword: !!options.requiresPassword,
          sharePassword: hashedPassword,
          notifyOnAccess: options.notifyOnAccess ?? true,
          canDownload: true,
          canPrint: true,
          canCopy: false,
          canShare: false
        }
      });

      return {
        shareLink: this.generateShareLink(shareToken),
        shareToken
      };
    } catch (error) {
      console.error('Failed to create share link:', error);
      return null;
    }
  }

  async accessSharedDocument(
    shareToken: string,
    accessorUserId?: string,
    password?: string,
    accessorInfo?: {
      ipAddress?: string;
      userAgent?: string;
      referrer?: string;
    }
  ): Promise<{ document: Document; permissions: SharePermissions; shareId: string } | null> {
    try {
      const share = await prisma.documentShare.findFirst({
        where: {
          shareToken,
          isActive: true
        },
        include: {
          document: true,
          sharer: {
            select: { id: true, firstName: true, lastName: true }
          },
          recipient: {
            select: { id: true, firstName: true, lastName: true }
          }
        }
      });

      if (!share) {
        throw new Error('Share link not found or inactive');
      }

      if (share.expiresAt && share.expiresAt < new Date()) {
        throw new Error('Share link has expired');
      }

      if (share.maxAccessCount && share.currentAccessCount >= share.maxAccessCount) {
        throw new Error('Share link has reached its maximum number of accesses');
      }

      if (share.requiresPassword) {
        if (!password || !share.sharePassword || !(await this.verifyPassword(password, share.sharePassword))) {
          throw new Error('Invalid password for shared document');
        }
      }

      if (share.shareType === ShareType.DIRECT && share.sharedWith && accessorUserId && accessorUserId !== share.sharedWith) {
        throw new Error('This shared document is restricted to a specific recipient');
      }

      await prisma.documentShare.update({
        where: { id: share.id },
        data: {
          currentAccessCount: { increment: 1 },
          lastAccessedAt: new Date(),
          lastAccessedBy: accessorUserId ?? share.lastAccessedBy ?? null
        }
      });

      await this.logShareAccess({
        shareId: share.id,
        accessorUserId,
        ipAddress: accessorInfo?.ipAddress,
        userAgent: accessorInfo?.userAgent,
        accessedAt: new Date()
      });

      const permissions = this.buildSharePermissions(share, accessorUserId);

      return {
        document: share.document,
        permissions,
        shareId: share.id
      };
    } catch (error) {
      console.error('Failed to access shared document:', error);
      return null;
    }
  }

  async getDocumentShares(
    documentId: string,
    ownerId: string
  ): Promise<Array<DocumentShare & {
    sharer: { id: string; firstName: string; lastName: string; email: string };
    recipient?: { id: string; firstName: string; lastName: string; email: string } | null;
  }>> {
    const document = await this.verifyOwnership(documentId, ownerId);
    if (!document) {
      return [];
    }

    return prisma.documentShare.findMany({
      where: {
        documentId,
        revokedAt: null
      },
      include: {
        sharer: {
          select: { id: true, firstName: true, lastName: true, email: true }
        },
        recipient: {
          select: { id: true, firstName: true, lastName: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getSharedWithUser(
    userId: string
  ): Promise<Array<DocumentShare & {
    document: Document & {
      owner: { id: string; firstName: string; lastName: string };
    };
    sharer: { id: string; firstName: string; lastName: string };
  }>> {
    return prisma.documentShare.findMany({
      where: {
        sharedWith: userId,
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      },
      include: {
        document: {
          include: {
            owner: {
              select: { id: true, firstName: true, lastName: true }
            }
          }
        },
        sharer: {
          select: { id: true, firstName: true, lastName: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async updateShare(shareId: string, updates: UpdateShareOptions): Promise<DocumentShare | null> {
    try {
      const share = await prisma.documentShare.findUnique({
        where: { id: shareId },
        include: { document: true }
      });

      if (!share) {
        return null;
      }

      if (updates.accessLevel) {
        this.validateAccessLevel(share.document.securityLevel, updates.accessLevel);
      }

      const data: Record<string, unknown> = {
        updatedAt: new Date()
      };

      if (updates.accessLevel) {
        data.accessLevel = updates.accessLevel;
      }

      if (updates.expiresAt !== undefined) {
        data.expiresAt = updates.expiresAt;
      }

      if (updates.allowDownload !== undefined) {
        data.canDownload = updates.allowDownload;
      }

      if (updates.allowPrint !== undefined) {
        data.canPrint = updates.allowPrint;
      }

      if (updates.allowCopy !== undefined) {
        data.canCopy = updates.allowCopy;
      }

      if (updates.allowReshare !== undefined) {
        data.canShare = updates.allowReshare;
      }

      if (updates.notifyOnAccess !== undefined) {
        data.notifyOnAccess = updates.notifyOnAccess;
      }

      if (updates.maxAccessCount !== undefined) {
        data.maxAccessCount = updates.maxAccessCount;
      }

      if (updates.requiresPassword !== undefined) {
        data.requiresPassword = updates.requiresPassword;
        if (!updates.requiresPassword) {
          data.sharePassword = null;
        }
      }

      if (updates.password !== undefined) {
        if (updates.password) {
          data.sharePassword = await this.hashPassword(updates.password);
          data.requiresPassword = true;
        } else {
          data.sharePassword = null;
          data.requiresPassword = false;
        }
      }

      const updatedShare = await prisma.documentShare.update({
        where: { id: shareId },
        data,
        include: {
          sharer: {
            select: { id: true, firstName: true, lastName: true, email: true }
          },
          recipient: {
            select: { id: true, firstName: true, lastName: true, email: true }
          }
        }
      });

      await this.logShareAction({
        shareId,
        action: 'SHARE_UPDATED',
        userId: share.sharedBy,
        details: { ...updates } as Record<string, unknown>
      });

      return updatedShare;
    } catch (error) {
      console.error('Failed to update share:', error);
      return null;
    }
  }

  async revokeShare(shareId: string, revokedBy: string): Promise<boolean> {
    try {
      const share = await prisma.documentShare.findUnique({
        where: { id: shareId },
        include: {
          document: true,
          recipient: {
            select: { id: true, email: true }
          }
        }
      });

      if (!share) {
        return false;
      }

      if (share.sharedBy !== revokedBy && share.document.ownerId !== revokedBy) {
        throw new Error('Insufficient permissions to revoke share');
      }

      await prisma.documentShare.update({
        where: { id: shareId },
        data: {
          isActive: false,
          revokedAt: new Date(),
          revokedBy
        }
      });

      if (share.recipient) {
        await this.sendShareRevokedNotification(share.id, share.recipient.email);
      }

      await this.logShareAction({
        shareId,
        action: 'SHARE_REVOKED',
        userId: revokedBy,
        details: {
          documentId: share.documentId,
          revokedUserId: share.sharedWith ?? share.sharedWithEmail
        }
      });

      return true;
    } catch (error) {
      console.error('Failed to revoke share:', error);
      return false;
    }
  }

  async getShareAnalytics(documentId: string, ownerId: string): Promise<ShareAnalytics | null> {
    try {
      const document = await this.verifyOwnership(documentId, ownerId);
      if (!document) {
        return null;
      }

      const shares = await prisma.documentShare.findMany({
        where: { documentId },
        include: {
          sharer: {
            select: { id: true, firstName: true, lastName: true }
          }
        }
      });

      const viewsByAccessLevel: Record<AccessLevel, number> = {
        [AccessLevel.READ]: 0,
        [AccessLevel.COMMENT]: 0,
        [AccessLevel.EDIT]: 0,
        [AccessLevel.FULL_ACCESS]: 0,
        [AccessLevel.OWNER]: 0
      };

      shares.forEach((share) => {
        viewsByAccessLevel[share.accessLevel] += share.currentAccessCount;
      });

      const sharesByUserMap = new Map<string, {
        userId: string;
        userName: string;
        shareCount: number;
        lastShared: Date;
      }>();

      shares.forEach((share) => {
        const userId = share.sharedBy;
        const userName = share.sharer ? `${share.sharer.firstName} ${share.sharer.lastName}` : 'Unknown User';

        if (!sharesByUserMap.has(userId)) {
          sharesByUserMap.set(userId, {
            userId,
            userName,
            shareCount: 0,
            lastShared: share.createdAt
          });
        }

        const stats = sharesByUserMap.get(userId)!;
        stats.shareCount += 1;
        if (share.createdAt > stats.lastShared) {
          stats.lastShared = share.createdAt;
        }
      });

      const sharesByUser = Array.from(sharesByUserMap.values()).sort((a, b) => b.shareCount - a.shareCount);

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentActivity = shares
        .filter((share) => share.createdAt >= thirtyDaysAgo)
        .map((share) => ({
          action: 'Document Shared',
          userId: share.sharedBy,
          userName: share.sharer ? `${share.sharer.firstName} ${share.sharer.lastName}` : 'Unknown User',
          timestamp: share.createdAt,
          details: {
            accessLevel: share.accessLevel,
            shareType: share.shareType,
            shareToken: share.shareToken
          }
        }))
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return {
        totalShares: shares.length,
        activeShares: shares.filter((share) => share.isActive).length,
        expiredShares: shares.filter((share) => share.expiresAt && share.expiresAt < new Date()).length,
        revokedShares: shares.filter((share) => share.revokedAt).length,
        viewsByAccessLevel,
        sharesByUser,
        recentActivity
      };
    } catch (error) {
      console.error('Failed to get share analytics:', error);
      return null;
    }
  }

  private async verifyOwnership(documentId: string, ownerId: string): Promise<Document | null> {
    return prisma.document.findFirst({
      where: {
        id: documentId,
        ownerId,
        status: { not: 'DELETED' }
      }
    });
  }

  private validateAccessLevel(documentSecurity: SecurityLevel, requestedAccess: AccessLevel): void {
    if (documentSecurity === SecurityLevel.TOP_SECRET && requestedAccess !== AccessLevel.READ) {
      throw new Error('Top secret documents may only be shared with read access');
    }

    if (
      documentSecurity === SecurityLevel.RESTRICTED &&
      requestedAccess !== AccessLevel.READ &&
      requestedAccess !== AccessLevel.COMMENT
    ) {
      throw new Error('Restricted documents can only be shared with read or comment access');
    }

    if (documentSecurity === SecurityLevel.CONFIDENTIAL && requestedAccess === AccessLevel.OWNER) {
      throw new Error('Confidential documents cannot be shared with owner-level access');
    }
  }

  private generateShareToken(): string {
    return crypto.randomUUID();
  }

  private generateShareLink(shareToken: string): string {
    const baseUrl = process.env.FRONTEND_URL || 'https://localhost:3000';
    return `${baseUrl}/shared/${shareToken}`;
  }

  private async hashPassword(password: string): Promise<string> {
    const bcrypt = require('bcryptjs');
    return bcrypt.hash(password, 10);
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    const bcrypt = require('bcryptjs');
    return bcrypt.compare(password, hash);
  }

  private buildSharePermissions(share: DocumentShare & { document: Document }, accessorUserId?: string): SharePermissions {
    const accessLevel = share.accessLevel;
    const canEdit =
      accessLevel === AccessLevel.EDIT ||
      accessLevel === AccessLevel.FULL_ACCESS ||
      accessLevel === AccessLevel.OWNER;
    const canComment =
      accessLevel === AccessLevel.COMMENT ||
      canEdit;
    const canShare =
      accessLevel === AccessLevel.FULL_ACCESS ||
      accessLevel === AccessLevel.OWNER;

    return {
      canView: true,
      canEdit,
      canComment,
      canShare,
      canDownload: share.canDownload,
      canPrint: share.canPrint,
      canCopy: share.canCopy,
      expiresAt: share.expiresAt ?? undefined,
      isOwner: accessorUserId === share.document.ownerId
    };
  }

  private async sendShareNotification(share: DocumentShare & {
    document: { id: string; fileName: string; ownerId: string };
    sharer: { id: string; firstName: string; lastName: string; email: string };
    recipient: { id: string; firstName: string; lastName: string; email: string } | null;
  }): Promise<void> {
    if (!share.recipient) {
      return;
    }

    try {
      const message = `${share.sharer.firstName} ${share.sharer.lastName} shared document "${share.document.fileName}" with you`;
      const clickAction = share.shareToken ? this.generateShareLink(share.shareToken) : undefined;

      await firebaseService.sendNotificationToUser(
        { userId: share.recipient.id },
        {
          title: 'Document Shared',
          body: message,
          data: {
            type: 'document_shared',
            documentId: share.document.id,
            shareId: share.id,
            accessLevel: share.accessLevel
          },
          clickAction
        }
      );
    } catch (error) {
      console.error('Failed to send share notification:', error);
    }
  }

  private async sendShareRevokedNotification(shareId: string, email?: string | null): Promise<void> {
    if (!email) {
      return;
    }

    console.log(`Share ${shareId} revoked for user ${email}`);
  }

  private async logShareAction(action: {
    shareId: string;
    action: string;
    userId: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    console.log('Share Action:', {
      shareId: action.shareId,
      action: action.action,
      userId: action.userId,
      details: action.details,
      timestamp: new Date()
    });
  }

  private async logShareAccess(access: {
    shareId: string;
    accessorUserId?: string;
    ipAddress?: string;
    userAgent?: string;
    accessedAt: Date;
  }): Promise<void> {
    console.log('Share Access:', access);
  }
}

export default new DocumentSharingService();
export {
  DocumentSharingService,
  ShareDocumentOptions,
  CreateShareLinkOptions,
  SharePermissions,
  ShareAnalytics
};