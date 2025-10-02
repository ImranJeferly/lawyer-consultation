import { CommentStatus, CommentType, Prisma } from '@prisma/client';
import prisma from '../config/database';

interface AddCommentOptions {
  documentId: string;
  userId: string;
  content: string;
  commentType?: string;
  parentId?: string;
  position?: {
    page?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  selectedText?: string;
  isPrivate?: boolean;
  mentionedUsers?: string[];
}

interface CommentQueryOptions {
  status?: string;
  commentType?: string;
  includePrivate?: boolean;
}

type CommentWithRelations = Prisma.DocumentCommentGetPayload<{
  include: {
    author: {
      select: {
        id: true;
        firstName: true;
        lastName: true;
        email: true;
      };
    };
    replies: {
      where: { deletedAt: null };
      orderBy: { createdAt: 'asc' };
      include: {
        author: {
          select: {
            id: true;
            firstName: true;
            lastName: true;
            email: true;
          };
        };
      };
    };
  };
}>;

interface CommentResponse {
  id: string;
  documentId: string;
  content: string;
  commentType: CommentType;
  status: CommentStatus;
  author: {
    id: string;
    fullName: string;
    email: string;
  };
  createdAt: Date;
  updatedAt: Date;
  pageNumber: number | null;
  position: Record<string, unknown> | null;
  selectedText: string | null;
  isPrivate: boolean;
  mentionedUsers: string[];
  parentCommentId: string | null;
  threadId: string | null;
  canEdit: boolean;
  canResolve: boolean;
  replies: CommentResponse[];
}

interface CollaboratorSummary {
  id: string;
  fullName: string;
  email: string;
  profileImageUrl: string | null;
  lastActiveAt: Date | null;
  recentActivity: Date | null;
  isCurrentUser: boolean;
}

class CollaborativeEditingService {
  async addComment(options: AddCommentOptions): Promise<CommentResponse> {
    const user = await prisma.user.findUnique({
      where: { id: options.userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true
      }
    });

    if (!user) {
      throw new Error('User not found');
    }

    let parentComment = null;
    let threadId: string | undefined;

    if (options.parentId) {
      parentComment = await prisma.documentComment.findUnique({
        where: { id: options.parentId }
      });

      if (!parentComment) {
        throw new Error('Parent comment not found');
      }

      if (parentComment.documentId !== options.documentId) {
        throw new Error('Parent comment belongs to a different document');
      }

      threadId = parentComment.threadId ?? parentComment.id;
    }

    const commentType = this.normalizeCommentType(options.commentType);
    const mentionedUsersValue = options.mentionedUsers && options.mentionedUsers.length > 0
      ? (options.mentionedUsers.map(String) as Prisma.InputJsonValue)
      : undefined;

    const positionValue = options.position
      ? (options.position as Prisma.InputJsonValue)
      : undefined;

    const created = await prisma.documentComment.create({
      data: {
        documentId: options.documentId,
        parentCommentId: options.parentId ?? null,
        threadId,
        content: options.content,
        commentType,
        authorId: user.id,
        authorName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
        pageNumber: typeof options.position?.page === 'number' ? options.position?.page : undefined,
        position: positionValue,
        selectedText: options.selectedText,
        status: CommentStatus.ACTIVE,
        isPrivate: options.isPrivate ?? false,
        mentionedUsers: mentionedUsersValue
      }
    });

    if (!threadId) {
      await prisma.documentComment.update({
        where: { id: created.id },
        data: { threadId: created.id }
      });
    }

    const fullComment = await prisma.documentComment.findUnique({
      where: { id: created.id },
      include: {
        author: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        }
      }
    });

    if (!fullComment) {
      throw new Error('Failed to load newly created comment');
    }

  return this.mapComment(fullComment, options.userId, options.isPrivate ?? false);
  }

  async getDocumentComments(
    documentId: string,
    userId: string,
    options: CommentQueryOptions = {}
  ): Promise<CommentResponse[]> {
    const where: Prisma.DocumentCommentWhereInput = {
      documentId,
      parentCommentId: null,
      deletedAt: null
    };

    if (options.commentType) {
      where.commentType = this.normalizeCommentType(options.commentType);
    }

    if (options.status) {
      where.status = this.normalizeCommentStatus(options.status);
    }

    if (!options.includePrivate) {
      where.OR = [
        { isPrivate: false },
        { authorId: userId }
      ];
    }

    const comments = await prisma.documentComment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        author: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        replies: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        }
      }
    });

    return comments
      .filter(comment => options.includePrivate || !comment.isPrivate || comment.authorId === userId)
      .map(comment => this.mapComment(comment, userId, options.includePrivate ?? false));
  }

  async getActiveCollaborators(documentId: string, userId: string): Promise<CollaboratorSummary[]> {
    const commentActivities = await prisma.documentComment.findMany({
      where: {
        documentId,
        deletedAt: null
      },
      select: {
        authorId: true,
        updatedAt: true
      },
      orderBy: { updatedAt: 'desc' }
    });

    const collaboratorIds: string[] = [];
    const recentActivity = new Map<string, Date>();

    for (const record of commentActivities) {
      if (!recentActivity.has(record.authorId)) {
        collaboratorIds.push(record.authorId);
        recentActivity.set(record.authorId, record.updatedAt);
      }
    }

    if (!collaboratorIds.length) {
      return [];
    }

    const users = await prisma.user.findMany({
      where: { id: { in: collaboratorIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        lastActiveAt: true,
        profileImageUrl: true
      }
    });

    const orderIndex = new Map<string, number>();
    collaboratorIds.forEach((id, index) => orderIndex.set(id, index));

    return users
      .map(user => ({
        id: user.id,
        fullName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
        email: user.email,
        profileImageUrl: user.profileImageUrl ?? null,
        lastActiveAt: user.lastActiveAt,
        recentActivity: recentActivity.get(user.id) ?? null,
        isCurrentUser: user.id === userId,
        sortIndex: orderIndex.get(user.id) ?? Number.MAX_SAFE_INTEGER
      }))
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map(({ sortIndex, ...rest }) => rest);
  }

  private mapComment(comment: CommentWithRelations, currentUserId: string, includePrivate: boolean): CommentResponse {
    const mentionedUsers = Array.isArray(comment.mentionedUsers)
      ? (comment.mentionedUsers as unknown[]).map(String)
      : [];

    const authorFullName = `${comment.author.firstName ?? ''} ${comment.author.lastName ?? ''}`.trim() || comment.author.email;

    const replies = (comment.replies ?? [])
      .filter(reply => includePrivate || !reply.isPrivate || reply.authorId === currentUserId)
      .map(reply => {
        const replyMentionedUsers = Array.isArray(reply.mentionedUsers)
          ? (reply.mentionedUsers as unknown[]).map(String)
          : [];

        const replyAuthorFullName = `${reply.author.firstName ?? ''} ${reply.author.lastName ?? ''}`.trim() || reply.author.email;

        return {
          id: reply.id,
          documentId: reply.documentId,
          content: reply.content,
          commentType: reply.commentType,
          status: reply.status,
          author: {
            id: reply.author.id,
            fullName: replyAuthorFullName,
            email: reply.author.email
          },
          createdAt: reply.createdAt,
          updatedAt: reply.updatedAt,
          pageNumber: reply.pageNumber ?? null,
          position: (reply.position as Record<string, unknown>) ?? null,
          selectedText: reply.selectedText ?? null,
          isPrivate: reply.isPrivate,
          mentionedUsers: replyMentionedUsers,
          parentCommentId: reply.parentCommentId ?? null,
          threadId: reply.threadId ?? null,
          canEdit: reply.authorId === currentUserId,
          canResolve: reply.authorId === currentUserId,
          replies: []
        } satisfies CommentResponse;
      });

    return {
      id: comment.id,
      documentId: comment.documentId,
      content: comment.content,
      commentType: comment.commentType,
      status: comment.status,
      author: {
        id: comment.author.id,
        fullName: authorFullName,
        email: comment.author.email
      },
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      pageNumber: comment.pageNumber ?? null,
      position: (comment.position as Record<string, unknown>) ?? null,
      selectedText: comment.selectedText ?? null,
      isPrivate: comment.isPrivate,
      mentionedUsers,
      parentCommentId: comment.parentCommentId ?? null,
      threadId: comment.threadId ?? null,
      canEdit: comment.authorId === currentUserId,
      canResolve: comment.authorId === currentUserId,
      replies
    };
  }

  private normalizeCommentType(type?: string | CommentType): CommentType {
    if (!type) {
      return CommentType.GENERAL;
    }

    if (typeof type !== 'string') {
      return type;
    }

    const normalized = type.toUpperCase();
    if ((Object.values(CommentType) as string[]).includes(normalized)) {
      return normalized as CommentType;
    }

    switch (type.toLowerCase()) {
      case 'annotation':
        return CommentType.ANNOTATION;
      case 'suggestion':
        return CommentType.SUGGESTION;
      case 'approval':
        return CommentType.APPROVAL;
      default:
        return CommentType.GENERAL;
    }
  }

  private normalizeCommentStatus(status?: string | CommentStatus): CommentStatus {
    if (!status) {
      return CommentStatus.ACTIVE;
    }

    if (typeof status !== 'string') {
      return status;
    }

    const normalized = status.toUpperCase();
    if ((Object.values(CommentStatus) as string[]).includes(normalized)) {
      return normalized as CommentStatus;
    }

    switch (status.toLowerCase()) {
      case 'resolved':
        return CommentStatus.RESOLVED;
      case 'archived':
        return CommentStatus.ARCHIVED;
      default:
        return CommentStatus.ACTIVE;
    }
  }
}

export default new CollaborativeEditingService();