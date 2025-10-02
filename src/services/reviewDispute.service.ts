// Review Dispute Service - Handles review disputes and resolution workflows
import { PrismaClient } from '@prisma/client';
import {
  ReviewDispute,
  CreateDisputeRequest,
  DisputeStatus,
  DisputeResolution
} from '../types/review.types';
import loggingService, { LogLevel, LogCategory } from './logging.service';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

class ReviewDisputeService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  // Create a new dispute
  async createDispute(
    reviewId: string,
    lawyerId: string,
    disputeData: CreateDisputeRequest
  ): Promise<ReviewDispute> {
    try {
      // Verify the review exists and belongs to this lawyer
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'The review you are trying to dispute was not found'
        });
      }

      if (review.lawyerId !== lawyerId) {
        throw new AppError(ErrorType.AUTHORIZATION_ERROR, 'Access denied', {
          severity: ErrorSeverity.HIGH,
          userMessage: 'You can only dispute reviews for your own appointments'
        });
      }

      // Check if dispute already exists
      const existingDispute = await this.prisma.reviewDispute.findFirst({
        where: {
          reviewId,
          lawyerId
        }
      });

      if (existingDispute) {
        throw new AppError(ErrorType.CONFLICT_ERROR, 'Dispute already exists', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'You have already disputed this review'
        });
      }

      // Validate dispute reason
      if (!disputeData.disputeReason || disputeData.disputeReason.length < 10) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Invalid dispute reason', {
          severity: ErrorSeverity.LOW,
          userMessage: 'Dispute reason must be at least 10 characters long'
        });
      }

      if (disputeData.evidenceDocuments && disputeData.evidenceDocuments.length > 5000) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Evidence too long', {
          severity: ErrorSeverity.LOW,
          userMessage: 'Supporting evidence must be 5000 characters or less'
        });
      }

      // Assess dispute status and validity
      const disputePriority = this.assessDisputePriority(disputeData);
      const status = await this.assessDisputeValidity(reviewId, disputeData);

      // Create the dispute
      const dispute = await this.prisma.reviewDispute.create({
        data: {
          reviewId,
          lawyerId,
          disputeReason: disputeData.disputeReason,
          disputeDescription: disputeData.disputeDescription,
          evidenceDocuments: disputeData.evidenceDocuments || [],
          witnessStatements: disputeData.witnessStatements,
          additionalEvidence: disputeData.additionalEvidence,
          status: 'pending'
        }
      });

      // Update review to indicate it's disputed
      await this.prisma.review.update({
        where: { id: reviewId },
        data: {
          isDisputed: true,
          disputeResolution: 'under_review'
        }
      });

      // Auto-hide review if dispute has high validity
      if (status > 0.8) {
        await this.prisma.review.update({
          where: { id: reviewId },
          data: {
            status: 'hidden',
            moderationStatus: 'flagged'
          }
        });
      }

      // Send notification to review author
      await this.notifyReviewAuthor(review.clientId, reviewId, dispute.id);

      loggingService.logUserAction('Review dispute created', {
        reviewId,
        disputeId: dispute.id,
        lawyerId,
        category: disputeData.disputeReason,
        status: disputePriority
      });

      return this.mapToDisputeInterface(dispute);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'createDispute',
        reviewId,
        lawyerId
      });
      throw error;
    }
  }

  // Get disputes for a lawyer
  async getLawyerDisputes(
    lawyerId: string,
    status?: DisputeStatus,
    page: number = 1,
    limit: number = 20
  ): Promise<{ disputes: ReviewDispute[], total: number, hasMore: boolean }> {
    try {
      const skip = (page - 1) * limit;
      const whereClause: any = { lawyerId };
      
      if (status) {
        whereClause.status = status;
      }

      const [disputes, total] = await Promise.all([
        this.prisma.reviewDispute.findMany({
          where: whereClause,
          include: {
            review: {
              select: {
                id: true,
                overallRating: true,
                reviewTitle: true,
                reviewText: true,
                createdAt: true,
                client: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true
                  }
                }
              }
            }
          },
          orderBy: [
            { status: 'desc' },
            { createdAt: 'desc' }
          ],
          skip,
          take: limit
        }),
        this.prisma.reviewDispute.count({ where: whereClause })
      ]);

      return {
        disputes: disputes.map(this.mapToDisputeInterface),
        total,
        hasMore: skip + disputes.length < total
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getLawyerDisputes',
        lawyerId,
        status
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to fetch disputes', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load disputes at this time'
      });
    }
  }

  // Get dispute details
  async getDisputeDetails(disputeId: string, lawyerId: string): Promise<ReviewDispute> {
    try {
      const dispute = await this.prisma.reviewDispute.findFirst({
        where: {
          id: disputeId,
          lawyerId
        },
        include: {
          review: {
            include: {
              client: {
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

      if (!dispute) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Dispute not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Dispute not found or access denied'
        });
      }

      return this.mapToDisputeInterface(dispute);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getDisputeDetails',
        disputeId,
        lawyerId
      });
      throw error;
    }
  }

  // Update a dispute (add additional evidence, etc.)
  async updateDispute(
    disputeId: string,
    lawyerId: string,
    updateData: Partial<CreateDisputeRequest>
  ): Promise<ReviewDispute> {
    try {
      const existingDispute = await this.prisma.reviewDispute.findFirst({
        where: {
          id: disputeId,
          lawyerId
        }
      });

      if (!existingDispute) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Dispute not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Dispute not found or access denied'
        });
      }

      // Only allow updates if dispute is still pending
      if (existingDispute.status !== 'pending') {
        throw new AppError(ErrorType.CONFLICT_ERROR, 'Cannot update resolved dispute', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'This dispute has already been processed and cannot be updated'
        });
      }

      // Re-assess validity if significant changes
      let status = existingDispute.status;
      if (updateData.evidenceDocuments && 
          updateData.evidenceDocuments !== existingDispute.evidenceDocuments) {
        const validityScore = await this.assessDisputeValidity(
          existingDispute.reviewId, 
          { ...existingDispute, ...updateData } as CreateDisputeRequest
        );
        status = validityScore > 0.7 ? 'high_priority' : validityScore > 0.4 ? 'medium_priority' : 'low_priority';
      }

      const updatedDispute = await this.prisma.reviewDispute.update({
        where: { id: disputeId },
        data: {
          ...updateData,
          status,
          updatedAt: new Date()
        }
      });

      loggingService.logUserAction('Dispute updated', {
        disputeId,
        lawyerId,
        changes: Object.keys(updateData)
      });

      return this.mapToDisputeInterface(updatedDispute);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'updateDispute',
        disputeId,
        lawyerId
      });
      throw error;
    }
  }

  // Withdraw a dispute
  async withdrawDispute(disputeId: string, lawyerId: string, reason?: string): Promise<void> {
    try {
      const dispute = await this.prisma.reviewDispute.findFirst({
        where: {
          id: disputeId,
          lawyerId
        }
      });

      if (!dispute) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Dispute not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Dispute not found or access denied'
        });
      }

      if (dispute.status !== 'pending') {
        throw new AppError(ErrorType.CONFLICT_ERROR, 'Cannot withdraw resolved dispute', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'This dispute has already been processed and cannot be withdrawn'
        });
      }

      // Update dispute status
      await this.prisma.reviewDispute.update({
        where: { id: disputeId },
        data: {
          status: 'withdrawn' as any,
          resolution: 'withdrawn_by_lawyer',
          resolutionNotes: reason,
          resolvedAt: new Date()
        }
      });

      // Update review status
      await this.prisma.review.update({
        where: { id: dispute.reviewId },
        data: {
          isDisputed: false,
          disputeResolution: 'withdrawn',
          status: 'published' // Restore if was hidden
        }
      });

      loggingService.logUserAction('Dispute withdrawn', {
        disputeId,
        reviewId: dispute.reviewId,
        lawyerId,
        reason
      });

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'withdrawDispute',
        disputeId,
        lawyerId
      });
      throw error;
    }
  }

  // Get dispute statistics for a lawyer
  async getDisputeStats(lawyerId: string): Promise<any> {
    try {
      const [
        totalDisputes,
        pendingDisputes,
        resolvedDisputes,
        successfulDisputes,
        disputesByCategory
      ] = await Promise.all([
        this.prisma.reviewDispute.count({ where: { lawyerId } }),
        this.prisma.reviewDispute.count({ 
          where: { lawyerId, status: 'pending' } 
        }),
        this.prisma.reviewDispute.count({ 
          where: { lawyerId, status: { in: ['resolved', 'rejected', 'withdrawn'] } } 
        }),
        this.prisma.reviewDispute.count({ 
          where: { lawyerId, resolution: { in: ['review_removed', 'review_modified'] } } 
        }),
        this.prisma.reviewDispute.groupBy({
          by: ['disputeReason'],
          where: { lawyerId },
          _count: { disputeReason: true }
        })
      ]);

      const successRate = resolvedDisputes > 0 ? 
        Math.round((successfulDisputes / resolvedDisputes) * 100) : 0;

      const averageResolutionTime = await this.calculateAverageResolutionTime(lawyerId);

      return {
        totalDisputes,
        pendingDisputes,
        resolvedDisputes,
        successfulDisputes,
        successRate,
        averageResolutionDays: averageResolutionTime,
        disputesByCategory: disputesByCategory.reduce((acc, item) => {
          acc[item.disputeReason] = item._count.disputeReason;
          return acc;
        }, {} as any)
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getDisputeStats',
        lawyerId
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get dispute statistics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load dispute statistics'
      });
    }
  }

  // Helper methods
  private assessDisputePriority(disputeData: CreateDisputeRequest): 'low' | 'medium' | 'high' {
    const highPriorityCategories = ['MISLEADING', 'identity_theft', 'SPAM'];
    const mediumPriorityCategories = ['service_not_provided', 'billing_dispute', 'INAPPROPRIATE'];

    if (highPriorityCategories.includes(disputeData.disputeReason || '')) {
      return 'high';
    }

    if (mediumPriorityCategories.includes(disputeData.disputeReason || '')) {
      return 'medium';
    }

    return 'low';
  }

  private async assessDisputeValidity(
    reviewId: string, 
    disputeData: CreateDisputeRequest
  ): Promise<number> {
    let score = 0.5; // Base score

    // Length and detail of dispute reason
    if (disputeData.disputeReason.length > 100) score += 0.1;
    if (disputeData.disputeReason.length > 500) score += 0.1;

    // Supporting evidence provided
    if (disputeData.evidenceDocuments && disputeData.evidenceDocuments.length > 50) {
      score += 0.2;
    }

    // Review characteristics that might support dispute
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId }
    });

    if (review) {
      // Very low ratings might indicate emotional rather than factual reviews
      if (review.overallRating === 1) score += 0.1;
      
      // Very short reviews might lack detail
      if ((review.reviewText?.length || 0) < 50) score += 0.1;
    }

    // Check for specific keywords that might indicate valid disputes
    const validityKeywords = ['never', 'didn\'t', 'false', 'incorrect', 'wrong'];
    const keywordCount = validityKeywords.filter(keyword => 
      disputeData.disputeReason.toLowerCase().includes(keyword)
    ).length;
    score += Math.min(keywordCount * 0.05, 0.2);

    return Math.max(0, Math.min(1, score));
  }

  private calculateExpectedResolution(status: 'low' | 'medium' | 'high'): Date {
    const now = new Date();
    const days = status === 'high' ? 3 : status === 'medium' ? 7 : 14;
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private async calculateAverageResolutionTime(lawyerId: string): Promise<number> {
    const resolvedDisputes = await this.prisma.reviewDispute.findMany({
      where: {
        lawyerId,
        status: { in: ['resolved', 'rejected', 'withdrawn'] },
        resolvedAt: { not: null }
      },
      select: {
        createdAt: true,
        resolvedAt: true
      }
    });

    if (resolvedDisputes.length === 0) return 0;

    const totalTime = resolvedDisputes.reduce((sum, dispute) => {
      if (dispute.resolvedAt && dispute.createdAt) {
        return sum + (dispute.resolvedAt.getTime() - dispute.createdAt.getTime());
      }
      return sum;
    }, 0);

    const averageMs = totalTime / resolvedDisputes.length;
    return Math.round(averageMs / (1000 * 60 * 60 * 24)); // Convert to days
  }

  private async notifyReviewAuthor(
    clientId: string, 
    reviewId: string, 
    disputeId: string
  ): Promise<void> {
    // Implementation would depend on notification system
    loggingService.log(LogLevel.INFO, LogCategory.API, 'Review dispute notification sent', {
      clientId,
      reviewId,
      disputeId
    });
  }

  private mapToDisputeInterface(dbDispute: any): ReviewDispute {
    return {
      id: dbDispute.id,
      reviewId: dbDispute.reviewId,
      lawyerId: dbDispute.lawyerId,
      disputeReason: dbDispute.disputeReason,
      disputeDescription: dbDispute.disputeDescription || '',
      evidenceDocuments: dbDispute.evidenceDocuments || [],
      additionalEvidence: dbDispute.additionalEvidence || {},
      status: dbDispute.status,
      resolution: dbDispute.resolution,
      resolutionNotes: dbDispute.resolutionNotes,
      isAppealed: dbDispute.isAppealed || false,
      reviewModified: dbDispute.reviewModified || false,
      reviewRemoved: dbDispute.reviewRemoved || false,
      compensationOffered: dbDispute.compensationOffered || false,
      isOverdue: dbDispute.isOverdue || false,
      createdAt: dbDispute.createdAt,
      resolvedAt: dbDispute.resolvedAt,
      updatedAt: dbDispute.updatedAt
    };
  }
}

export default new ReviewDisputeService();