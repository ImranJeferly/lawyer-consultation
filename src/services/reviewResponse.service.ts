// Review Response Service - Handles lawyer responses to reviews
import { PrismaClient } from '@prisma/client';
import {
  ReviewResponse,
  CreateResponseRequest,
  ResponseType,
  ReviewStatus,
  ModerationStatus
} from '../types/review.types';
import loggingService, { LogLevel, LogCategory } from './logging.service';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

class ReviewResponseService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  // Create a new response to a review
  async createResponse(
    reviewId: string,
    lawyerId: string,
    responseData: CreateResponseRequest
  ): Promise<ReviewResponse> {
    try {
      // Verify the review exists and belongs to appointments with this lawyer
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId },
        include: { appointment: true }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'The review you are trying to respond to was not found'
        });
      }

      if (review.lawyerId !== lawyerId) {
        throw new AppError(ErrorType.AUTHORIZATION_ERROR, 'Access denied', {
          severity: ErrorSeverity.HIGH,
          userMessage: 'You can only respond to reviews for your own appointments'
        });
      }

      // Check if response already exists
      const existingResponse = await this.prisma.reviewResponse.findFirst({
        where: {
          reviewId,
          lawyerId
        }
      });

      if (existingResponse) {
        throw new AppError(ErrorType.CONFLICT_ERROR, 'Response already exists', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'You have already responded to this review'
        });
      }

      // Validate response content
      if (responseData.responseText.length > 2000) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Response too long', {
          severity: ErrorSeverity.LOW,
          userMessage: 'Response must be 2000 characters or less'
        });
      }

      // Analyze response quality and tone
      const responseQuality = await this.analyzeResponseQuality(responseData.responseText);
      const responseTone = await this.analyzeResponseTone(responseData.responseText);

      // Determine if auto-approval is appropriate
      let status = ReviewStatus.PENDING;
      let moderationStatus = ModerationStatus.PENDING;

      if (responseQuality.score > 8 && responseTone === 'professional') {
        status = ReviewStatus.PUBLISHED;
        moderationStatus = ModerationStatus.APPROVED;
      }

      // Create the response
      const response = await this.prisma.reviewResponse.create({
        data: {
          reviewId,
          lawyerId,
          responseText: responseData.responseText,
          responseLength: responseData.responseText.length,
          responseType: responseData.responseType || 'standard',
          responseTone,
          status: status as string,
          moderationStatus: moderationStatus as string,
          responseQualityScore: responseQuality.score,
          publishedAt: status === 'published' ? new Date() : null
        }
      });

      // Update review to indicate it has a response
      await this.prisma.review.update({
        where: { id: reviewId },
        data: {
          reviewMetadata: {
            ...review.reviewMetadata as any,
            hasResponse: true,
            responseCreatedAt: new Date().toISOString()
          }
        }
      });

      // Send notification to review author
      await this.notifyReviewAuthor(review.clientId, reviewId, response.id);

      loggingService.logUserAction('Review response created', {
        reviewId,
        responseId: response.id,
        lawyerId,
        responseType: responseData.responseType,
        qualityScore: responseQuality.score
      });

      return this.mapToResponseInterface(response);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'createResponse',
        reviewId,
        lawyerId
      });
      throw error;
    }
  }

  // Get responses for a review
  async getReviewResponses(reviewId: string): Promise<ReviewResponse[]> {
    try {
      const responses = await this.prisma.reviewResponse.findMany({
        where: {
          reviewId,
          status: ReviewStatus.PUBLISHED
        },
        include: {
          lawyer: {
            select: {
              id: true,
              userId: true,
              user: {
                select: {
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        },
        orderBy: { publishedAt: 'asc' }
      });

      return responses.map(this.mapToResponseInterface);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getReviewResponses',
        reviewId
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to fetch responses', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load responses at this time'
      });
    }
  }

  // Update a response
  async updateResponse(
    responseId: string,
    lawyerId: string,
    updateData: Partial<CreateResponseRequest>
  ): Promise<ReviewResponse> {
    try {
      const existingResponse = await this.prisma.reviewResponse.findFirst({
        where: {
          id: responseId,
          lawyerId
        }
      });

      if (!existingResponse) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Response not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Response not found or access denied'
        });
      }

      // Preserve original content on first edit
      const originalResponse = existingResponse.editCount === 0 ? 
        existingResponse.responseText : 
        existingResponse.originalResponse;

      // Re-analyze quality if text changed
      let responseQuality = { score: existingResponse.responseQualityScore };
      let responseTone = existingResponse.responseTone;

      if (updateData.responseText && updateData.responseText !== existingResponse.responseText) {
        responseQuality = await this.analyzeResponseQuality(updateData.responseText);
        responseTone = await this.analyzeResponseTone(updateData.responseText);
      }

      const updatedResponse = await this.prisma.reviewResponse.update({
        where: { id: responseId },
        data: {
          ...updateData,
          responseLength: updateData.responseText ? updateData.responseText.length : undefined,
          responseTone,
          responseQualityScore: responseQuality.score,
          editCount: existingResponse.editCount + 1,
          lastEditedAt: new Date(),
          originalResponse,
          // Re-moderate if significant change
          moderationStatus: this.requiresReModeration(existingResponse, updateData) ? 
            ModerationStatus.PENDING : 
            existingResponse.moderationStatus
        }
      });

      loggingService.logUserAction('Review response updated', {
        responseId,
        lawyerId,
        editCount: updatedResponse.editCount
      });

      return this.mapToResponseInterface(updatedResponse);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'updateResponse',
        responseId,
        lawyerId
      });
      throw error;
    }
  }

  // Delete a response
  async deleteResponse(responseId: string, lawyerId: string): Promise<void> {
    try {
      const response = await this.prisma.reviewResponse.findFirst({
        where: {
          id: responseId,
          lawyerId
        }
      });

      if (!response) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Response not found', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Response not found or access denied'
        });
      }

      // Soft delete - hide but preserve for audit
      await this.prisma.reviewResponse.update({
        where: { id: responseId },
        data: {
          status: ReviewStatus.HIDDEN,
          isPublic: false
        }
      });

      // Update review metadata
      await this.prisma.review.update({
        where: { id: response.reviewId },
        data: {
          reviewMetadata: {
            hasResponse: false,
            responseDeletedAt: new Date().toISOString()
          }
        }
      });

      loggingService.logUserAction('Review response deleted', {
        responseId,
        lawyerId,
        reviewId: response.reviewId
      });

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'deleteResponse',
        responseId,
        lawyerId
      });
      throw error;
    }
  }

  // Get response statistics for a lawyer
  async getLawyerResponseStats(lawyerId: string): Promise<any> {
    try {
      const stats = await this.prisma.reviewResponse.findMany({
        where: {
          lawyerId,
          status: ReviewStatus.PUBLISHED
        },
        include: {
          review: {
            select: {
              publishedAt: true,
              createdAt: true
            }
          }
        }
      });

      const totalResponses = stats.length;
      const totalReviews = await this.prisma.review.count({
        where: { lawyerId, status: ReviewStatus.PUBLISHED }
      });

      const responseRate = totalReviews > 0 ? (totalResponses / totalReviews) * 100 : 0;

      // Calculate average response time
      const responseTimes = stats
        .filter(s => s.review.publishedAt && s.publishedAt)
        .map(s => {
          const reviewTime = s.review.publishedAt!.getTime();
          const responseTime = s.publishedAt!.getTime();
          return (responseTime - reviewTime) / (1000 * 60 * 60); // hours
        });

      const averageResponseTime = responseTimes.length > 0 ? 
        responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length : 0;

      const averageQuality = stats.length > 0 ? 
        stats.reduce((sum, s) => sum + s.responseQualityScore, 0) / stats.length : 0;

      return {
        totalResponses,
        responseRate: Math.round(responseRate),
        averageResponseTime: Math.round(averageResponseTime),
        averageQualityScore: Math.round(averageQuality * 100) / 100,
        responsesThisMonth: stats.filter(s => 
          s.createdAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        ).length
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getLawyerResponseStats',
        lawyerId
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get response statistics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load response statistics'
      });
    }
  }

  // Helper methods
  private async analyzeResponseQuality(responseText: string): Promise<{ score: number }> {
    let score = 5; // Base score

    // Length assessment
    if (responseText.length > 100) score += 1;
    if (responseText.length > 300) score += 1;

    // Professional language indicators
    const professionalTerms = ['thank', 'appreciate', 'understand', 'apologize', 'improve'];
    const foundTerms = professionalTerms.filter(term => 
      responseText.toLowerCase().includes(term)
    ).length;
    score += foundTerms;

    // Personalization indicators
    if (responseText.includes('specific') || responseText.includes('particular')) {
      score += 1;
    }

    // Avoid defensive language
    const defensiveTerms = ['wrong', 'false', 'untrue', 'never said'];
    const defensiveCount = defensiveTerms.filter(term => 
      responseText.toLowerCase().includes(term)
    ).length;
    score -= defensiveCount;

    return { score: Math.max(0, Math.min(10, score)) };
  }

  private async analyzeResponseTone(responseText: string): Promise<string> {
    const text = responseText.toLowerCase();

    if (text.includes('thank') || text.includes('appreciate') || text.includes('grateful')) {
      return 'grateful';
    }

    if (text.includes('sorry') || text.includes('apologize') || text.includes('regret')) {
      return 'apologetic';
    }

    if (text.includes('understand') && text.includes('improve')) {
      return 'constructive';
    }

    if (text.includes('wrong') || text.includes('false') || text.includes('disagree')) {
      return 'defensive';
    }

    return 'professional';
  }

  private requiresReModeration(existingResponse: any, updateData: any): boolean {
    if (!updateData.responseText) return false;

    // Check if content changed significantly
    const contentChangePercentage = Math.abs(
      updateData.responseText.length - existingResponse.responseText.length
    ) / existingResponse.responseText.length;

    return contentChangePercentage > 0.3;
  }

  private async notifyReviewAuthor(clientId: string, reviewId: string, responseId: string): Promise<void> {
    // Implementation would depend on notification system
    // For now, just log the notification
    loggingService.log(LogLevel.INFO, LogCategory.API, 'Review response notification sent', {
      clientId,
      reviewId,
      responseId
    });
  }

  private mapToResponseInterface(dbResponse: any): ReviewResponse {
    return {
      id: dbResponse.id,
      reviewId: dbResponse.reviewId,
      lawyerId: dbResponse.lawyerId,
      responseText: dbResponse.responseText,
      responseLength: dbResponse.responseLength,
      responseType: dbResponse.responseType,
      responseTone: dbResponse.responseTone,
      status: dbResponse.status,
      moderationStatus: dbResponse.moderationStatus,
      moderatedBy: dbResponse.moderatedBy,
      moderatedAt: dbResponse.moderatedAt,
      moderationNotes: dbResponse.moderationNotes,
      isHelpful: dbResponse.isHelpful,
      helpfulVotes: dbResponse.helpfulVotes,
      responseQualityScore: dbResponse.responseQualityScore,
      publishedAt: dbResponse.publishedAt,
      isPublic: dbResponse.isPublic,
      editCount: dbResponse.editCount,
      lastEditedAt: dbResponse.lastEditedAt,
      originalResponse: dbResponse.originalResponse,
      viewCount: dbResponse.viewCount,
      createdAt: dbResponse.createdAt,
      updatedAt: dbResponse.updatedAt
    };
  }
}

export default new ReviewResponseService();