// Review Moderation Service - Handles review content moderation and approval workflows
import { PrismaClient } from '@prisma/client';
import {
  Review,
  ReviewFlag,
  ModerationStatus,
  ReviewStatus,
  FlagReason,
  ModerationAction
} from '../types/review.types';
import loggingService, { LogLevel, LogCategory } from './logging.service';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

class ReviewModerationService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  // Get reviews pending moderation
  async getPendingReviews(
    page: number = 1,
    limit: number = 20,
    filterBy?: { 
      status?: 'high' | 'medium' | 'low',
      type?: 'review' | 'response',
      flaggedOnly?: boolean 
    }
  ): Promise<{ reviews: any[], total: number, hasMore: boolean }> {
    try {
      const skip = (page - 1) * limit;
      
      let whereClause: any = {
        moderationStatus: 'pending'
      };

      // Add filtering
      if (filterBy?.flaggedOnly) {
        whereClause.flags = {
          some: {
            status: 'pending'
          }
        };
      }

      const [reviews, total] = await Promise.all([
        this.prisma.review.findMany({
          where: whereClause,
          include: {
            client: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            },
            appointment: {
              select: {
                id: true,
                createdAt: true,
                status: true
              }
            },
            flags: {
              where: { status: 'pending' },
              include: {
                review: {
                  select: {
                    id: true,
                    clientId: true,
                    reviewText: true
                  }
                }
              }
            }
          },
          orderBy: [
            { flags: { _count: 'desc' } }, // Flagged reviews first
            { createdAt: 'asc' } // Oldest first
          ],
          skip,
          take: limit
        }),
        this.prisma.review.count({ where: whereClause })
      ]);

      return {
        reviews,
        total,
        hasMore: skip + reviews.length < total
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getPendingReviews',
        page,
        limit
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to fetch pending reviews', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load pending reviews'
      });
    }
  }

  // Moderate a review (approve/reject)
  async moderateReview(
    reviewId: string,
    moderatorId: string,
    action: ModerationAction,
    notes?: string
  ): Promise<any> {
    try {
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId },
        include: { flags: { where: { status: 'pending' } } }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Review not found'
        });
      }

      let updateData: any = {
        moderatedBy: moderatorId,
        moderatedAt: new Date(),
        moderationNotes: notes
      };

      switch (action) {
        case 'approve':
          updateData.moderationStatus = 'approved';
          updateData.status = 'published';
          updateData.publishedAt = new Date();
          break;
        
        case 'reject':
          updateData.moderationStatus = 'rejected';
          updateData.status = 'rejected';
          break;
        
        case 'flag':
          updateData.moderationStatus = 'flagged';
          updateData.status = 'hidden';
          break;
        
        case 'require_edit':
          updateData.moderationStatus = 'requires_edit';
          updateData.status = 'pending';
          break;
      }

      const updatedReview = await this.prisma.review.update({
        where: { id: reviewId },
        data: updateData
      });

      // Handle pending flags if approved
      if (action === 'approve' && review.flags.length > 0) {
        await this.prisma.reviewFlag.updateMany({
          where: {
            reviewId,
            status: 'pending'
          },
          data: {
            status: 'resolved',
            resolution: 'review_approved'
          }
        });
      }

      // Send notification to review author
      await this.notifyReviewAuthor(review.clientId, reviewId, action);

      loggingService.logUserAction('Review moderated', {
        reviewId,
        moderatorId,
        action,
        previousStatus: review.moderationStatus,
        newStatus: updateData.moderationStatus
      });

      return updatedReview;

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'moderateReview',
        reviewId,
        moderatorId,
        action
      });
      throw error;
    }
  }

  // Flag a review for moderation
  async flagReview(
    reviewId: string,
    reason: FlagReason,
    description?: string
  ): Promise<ReviewFlag> {
    try {
      // Check if review exists
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Review not found'
        });
      }

      // Check if user already flagged this review
      const existingFlag = await this.prisma.reviewFlag.findFirst({
        where: {
          reviewId,
          flaggerId: 'current-user' // This would be passed as parameter in real implementation
        }
      });

      if (existingFlag) {
        throw new AppError(ErrorType.CONFLICT_ERROR, 'Already flagged', {
          severity: ErrorSeverity.LOW,
          userMessage: 'You have already flagged this review'
        });
      }

      // Create flag
      const flag = await this.prisma.reviewFlag.create({
        data: {
          reviewId,
          flaggerId: 'current-user', // This would be passed as parameter in real implementation
          flagReason: reason,
          flagDescription: description,
          status: 'pending'
        }
      });

      // Auto-hide review if multiple flags or severe reason
      const flagCount = await this.prisma.reviewFlag.count({
        where: { reviewId, status: 'pending' }
      });

      if (flagCount >= 3 || ['SPAM', 'INAPPROPRIATE', 'SPAM'].includes(reason)) {
        await this.prisma.review.update({
          where: { id: reviewId },
          data: {
            status: 'hidden',
            moderationStatus: 'flagged'
          }
        });
      }

      loggingService.logUserAction('Review flagged', {
        reviewId,
        reason,
        flagCount,
        flagId: flag.id
      });

      return this.mapToFlagInterface(flag);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'flagReview',
        reviewId,
        reason
      });
      throw error;
    }
  }

  // Get moderation statistics
  async getModerationStats(
    timeframe: 'day' | 'week' | 'month' = 'week'
  ): Promise<any> {
    try {
      const now = new Date();
      let startDate: Date;

      switch (timeframe) {
        case 'day':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      const [
        totalPending,
        totalApproved,
        totalRejected,
        totalFlagged,
        recentFlags,
        averageProcessingTime
      ] = await Promise.all([
        this.prisma.review.count({
          where: { moderationStatus: 'pending' }
        }),
        this.prisma.review.count({
          where: {
            moderationStatus: 'approved',
            moderatedAt: { gte: startDate }
          }
        }),
        this.prisma.review.count({
          where: {
            moderationStatus: 'rejected',
            moderatedAt: { gte: startDate }
          }
        }),
        this.prisma.reviewFlag.count({
          where: {
            status: 'pending',
            createdAt: { gte: startDate }
          }
        }),
        this.prisma.reviewFlag.findMany({
          where: {
            createdAt: { gte: startDate }
          },
          include: {
            review: {
              select: {
                id: true,
                reviewTitle: true,
                clientId: true
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        }),
        this.calculateAverageProcessingTime(startDate)
      ]);

      return {
        summary: {
          totalPending,
          totalApproved,
          totalRejected,
          totalFlagged,
          averageProcessingHours: averageProcessingTime
        },
        recentFlags,
        timeframe
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getModerationStats',
        timeframe
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get moderation statistics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load moderation statistics'
      });
    }
  }

  // Auto-moderate based on content analysis
  async autoModerate(reviewId: string): Promise<{ action: string, confidence: number, reasons: string[] }> {
    try {
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found');
      }

      const analysis = await this.analyzeContent(review.reviewText || '');
      
      let action = 'approve';
      let confidence = analysis.confidence;
      const reasons: string[] = [];

      // Check for problematic content
      if (analysis.toxicity > 0.8) {
        action = 'reject';
        reasons.push('High toxicity detected');
      } else if (analysis.spam > 0.7) {
        action = 'flag';
        reasons.push('Potential spam content');
      } else if (analysis.profanity > 0.6) {
        action = 'require_edit';
        reasons.push('Inappropriate language');
      }

      // Apply auto-moderation if confidence is high
      if (confidence > 0.9 && action !== 'approve') {
        await this.moderateReview(reviewId, 'system_auto', action as ModerationAction, 
          `Auto-moderated: ${reasons.join(', ')}`);
      }

      return { action, confidence, reasons };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'autoModerate',
        reviewId
      });
      throw error;
    }
  }

  // Helper methods
  private calculateFlagPriority(reason: FlagReason): 'low' | 'medium' | 'high' {
    const highPriority: FlagReason[] = [FlagReason.SPAM, FlagReason.INAPPROPRIATE_CONTENT];
    const mediumPriority: FlagReason[] = [FlagReason.INAPPROPRIATE_CONTENT, FlagReason.PERSONAL_ATTACK];
    
    if (highPriority.includes(reason)) return 'high';
    if (mediumPriority.includes(reason)) return 'medium';
    return 'low';
  }

  private async calculateAverageProcessingTime(startDate: Date): Promise<number> {
    const processedReviews = await this.prisma.review.findMany({
      where: {
        moderatedAt: { gte: startDate },
        moderationStatus: { in: ['approved', 'rejected'] }
      },
      select: {
        createdAt: true,
        moderatedAt: true
      }
    });

    if (processedReviews.length === 0) return 0;

    const totalTime = processedReviews.reduce((sum, review) => {
      if (review.moderatedAt) {
        return sum + (review.moderatedAt.getTime() - review.createdAt.getTime());
      }
      return sum;
    }, 0);

    return Math.round(totalTime / processedReviews.length / (1000 * 60 * 60)); // hours
  }

  private async analyzeContent(content: string): Promise<{
    toxicity: number,
    spam: number,
    profanity: number,
    confidence: number
  }> {
    // Simplified content analysis - in production would use ML services
    const lowerContent = content.toLowerCase();
    
    // Basic toxicity detection
    const toxicWords = ['hate', 'terrible', 'awful', 'worst', 'scam', 'fraud'];
    const toxicCount = toxicWords.filter(word => lowerContent.includes(word)).length;
    const toxicity = Math.min(toxicCount / toxicWords.length, 1);

    // Basic spam detection
    const spamIndicators = ['click here', 'visit my', 'www.', 'http', 'call now'];
    const spamCount = spamIndicators.filter(indicator => lowerContent.includes(indicator)).length;
    const spam = Math.min(spamCount / spamIndicators.length, 1);

    // Basic profanity detection
    const profanityWords = ['damn', 'hell', 'stupid', 'idiot']; // Basic list
    const profanityCount = profanityWords.filter(word => lowerContent.includes(word)).length;
    const profanity = Math.min(profanityCount / profanityWords.length, 1);

    const confidence = 0.7; // Base confidence for simple analysis

    return { toxicity, spam, profanity, confidence };
  }

  private async notifyReviewAuthor(clientId: string, reviewId: string, action: ModerationAction): Promise<void> {
    // Implementation would depend on notification system
    loggingService.log(LogLevel.INFO, LogCategory.USER_ACTION, 'Review moderation notification sent', {
      clientId,
      reviewId,
      action
    });
  }

  private mapToFlagInterface(dbFlag: any): ReviewFlag {
    return {
      id: dbFlag.id,
      reviewId: dbFlag.reviewId,
      flaggerId: dbFlag.flaggerId,
      flagReason: dbFlag.flagReason,
      flagDescription: dbFlag.flagDescription,
      evidenceUrls: dbFlag.evidenceUrls || [],
      additionalContext: dbFlag.additionalContext,
      status: dbFlag.status,
      investigatedBy: dbFlag.investigatedBy,
      investigatedAt: dbFlag.investigatedAt,
      investigationNotes: dbFlag.investigationNotes,
      resolution: dbFlag.resolution,
      isValidFlag: dbFlag.isValidFlag,
      flagQualityScore: dbFlag.flagQualityScore || 0,
      flaggerNotified: dbFlag.flaggerNotified || false,
      reviewAuthorNotified: dbFlag.reviewAuthorNotified || false,
      createdAt: dbFlag.createdAt,
      updatedAt: dbFlag.updatedAt
    };
  }
}

export default new ReviewModerationService();