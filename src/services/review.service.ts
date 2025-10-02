// Comprehensive Review Service with fraud detection and multi-dimensional ratings
import { PrismaClient, Prisma } from '@prisma/client';
import prismaClient from '../config/database';
import {
  Review,
  CreateReviewData,
  UpdateReviewData,
  ReviewStatus,
  ModerationStatus,
  ValidationResult,
  FraudAnalysis,
  ReviewCreationResult,
  ReviewStatistics,
  ReviewFilters,
  PaginatedReviews,
  ReviewInsights,
  DetailedRatingStats,
  ReviewListItem,
  ReviewResponseSummary,
  ReviewClientSummary,
  PlatformReviewStats
} from '../types/review.types';
import loggingService from './logging.service';
import reviewAnalyticsService from './reviewAnalytics.service';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

export class ReviewService {
  private prisma: PrismaClient;

  constructor(prismaInstance: PrismaClient = prismaClient) {
    this.prisma = prismaInstance;
  }

  // Create a new review with comprehensive validation and fraud detection
  async createReview(
    reviewData: CreateReviewData,
    clientId: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<ReviewCreationResult> {
    try {
      // 1. Validate review eligibility
      const eligibilityResult = await this.validateReviewEligibility(clientId, reviewData.appointmentId);
      if (!eligibilityResult.isValid) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Review eligibility validation failed', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: eligibilityResult.errors.join(', ')
        });
      }

      // 2. Validate review content
      const contentValidation = await this.validateReviewContent(reviewData);
      if (!contentValidation.isValid) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Review content validation failed', {
          severity: ErrorSeverity.LOW,
          userMessage: contentValidation.errors.join(', ')
        });
      }

      // 3. Get appointment details for context
      const appointment = await this.getAppointmentDetails(reviewData.appointmentId);
      if (!appointment) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Appointment not found', {
          severity: ErrorSeverity.HIGH,
          userMessage: 'Associated appointment could not be found'
        });
      }

      // 4. Run fraud detection
      const fraudAnalysis = await this.analyzeReviewAuthenticity(reviewData, clientId, appointment);

      // 5. Calculate verification score
      const verificationScore = await this.calculateVerificationScore(reviewData, appointment);

      // 6. Determine initial status based on fraud analysis
      let status = ReviewStatus.PENDING;
      let moderationStatus = ModerationStatus.PENDING;
      
      if (fraudAnalysis.riskLevel === 'low' && verificationScore > 80) {
        status = ReviewStatus.PUBLISHED;
        moderationStatus = ModerationStatus.APPROVED;
      } else if (fraudAnalysis.riskLevel === 'critical') {
        status = ReviewStatus.REJECTED;
        moderationStatus = ModerationStatus.REJECTED;
      }

      // 7. Create review record
      const review = await this.prisma.review.create({
        data: {
          appointmentId: reviewData.appointmentId,
          clientId,
          lawyerId: appointment.lawyerId,
          overallRating: reviewData.overallRating,
          communicationRating: reviewData.communicationRating,
          expertiseRating: reviewData.expertiseRating,
          responsivenessRating: reviewData.responsivenessRating,
          valueRating: reviewData.valueRating,
          professionalismRating: reviewData.professionalismRating,
          reviewTitle: reviewData.reviewTitle,
          reviewText: reviewData.reviewText,
          consultationType: reviewData.consultationType,
          caseCategory: reviewData.caseCategory,
          recommendsLawyer: reviewData.recommendsLawyer,
          isVerified: verificationScore > 70,
          verificationMethod: 'appointment_confirmed',
          verificationScore,
          status,
          moderationStatus,
          sentimentScore: await this.analyzeSentiment(reviewData.reviewText || ''),
          contentQualityScore: await this.calculateContentQuality(reviewData.reviewText || ''),
          isHighQuality: this.isHighQualityReview(reviewData),
          autoModerationFlags: fraudAnalysis.flags,
          userAgent,
          ipAddress,
          publishedAt: status === ReviewStatus.PUBLISHED ? new Date() : null
        }
      });

      // 8. Update lawyer rating aggregations if published
      if (status === ReviewStatus.PUBLISHED) {
        await this.updateLawyerRatingAggregations(appointment.lawyerId);
      }

      // 9. Log review creation
      loggingService.logUserAction(`Review created for lawyer ${appointment.lawyerId}`, {
        reviewId: review.id,
        clientId,
        lawyerId: appointment.lawyerId,
        overallRating: reviewData.overallRating,
        fraudRiskLevel: fraudAnalysis.riskLevel,
        verificationScore
      });

      return {
        review: this.mapToReviewInterface(review),
        fraudAnalysis,
        validationResult: contentValidation
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'createReview',
        clientId,
        appointmentId: reviewData.appointmentId
      });
      throw error;
    }
  }

  // Validate if user can review this appointment
  async validateReviewEligibility(clientId: string, appointmentId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check if appointment exists and belongs to client
      const appointment = await this.prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          clientId,
          status: 'COMPLETED'
        }
      });

      if (!appointment) {
        errors.push('Appointment not found or not completed');
      }

      // Check for existing review
      const existingReview = await this.prisma.review.findFirst({
        where: {
          appointmentId,
          clientId,
          status: { not: ReviewStatus.REJECTED }
        }
      });

      if (existingReview) {
        errors.push('Review already exists for this appointment');
      }

      // Check if client is banned from reviewing
      const clientStatus = await this.getClientReviewStatus(clientId);
      if (clientStatus.isBanned) {
        errors.push('Account restricted from leaving reviews');
      }

      // Check review submission window (e.g., within 90 days of appointment)
      if (appointment) {
        const daysSinceAppointment = Math.floor(
          (Date.now() - appointment.startTime.getTime()) / (1000 * 60 * 60 * 24)
        );
        
        if (daysSinceAppointment > 90) {
          warnings.push('Review submitted after 90-day window - may require additional verification');
        }
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };

    } catch (error) {
      return {
        isValid: false,
        errors: ['Failed to validate review eligibility'],
        warnings: []
      };
    }
  }

  // Validate review content
  async validateReviewContent(reviewData: CreateReviewData): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate ratings
    if (reviewData.overallRating < 1 || reviewData.overallRating > 5) {
      errors.push('Overall rating must be between 1 and 5');
    }

    const dimensionalRatings = [
      reviewData.communicationRating,
      reviewData.expertiseRating,
      reviewData.responsivenessRating,
      reviewData.valueRating,
      reviewData.professionalismRating
    ];

    dimensionalRatings.forEach((rating, index) => {
      if (rating !== undefined && (rating < 1 || rating > 5)) {
        const dimensions = ['communication', 'expertise', 'responsiveness', 'value', 'professionalism'];
        errors.push(`${dimensions[index]} rating must be between 1 and 5`);
      }
    });

    // Validate text content
    if (reviewData.reviewText) {
      if (reviewData.reviewText.length < 10) {
        warnings.push('Review text is very short - consider adding more detail');
      }
      
      if (reviewData.reviewText.length > 5000) {
        errors.push('Review text exceeds maximum length of 5000 characters');
      }

      // Check for inappropriate content
      const inappropriateContent = await this.detectInappropriateContent(reviewData.reviewText);
      if (inappropriateContent.hasViolations) {
        errors.push('Review contains inappropriate content');
      }
    }

    // Validate title
    if (reviewData.reviewTitle && reviewData.reviewTitle.length > 200) {
      errors.push('Review title exceeds maximum length of 200 characters');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  // Comprehensive fraud detection analysis
  async analyzeReviewAuthenticity(
    reviewData: CreateReviewData,
    clientId: string,
    appointment: any
  ): Promise<FraudAnalysis> {
    const flags: string[] = [];
    let riskScore = 0;

    // Content analysis
    const contentAnalysis = await this.analyzeReviewContent(reviewData.reviewText || '');
    if (contentAnalysis.duplicateScore > 0.8) {
      flags.push('potential_duplicate_content');
      riskScore += 30;
    }

    if (contentAnalysis.specificityScore < 0.3) {
      flags.push('generic_content');
      riskScore += 15;
    }

    // User pattern analysis
    const userHistory = await this.getUserReviewHistory(clientId);
    if (userHistory.reviewCount > 50 && userHistory.averageRating > 4.8) {
      flags.push('suspicious_rating_pattern');
      riskScore += 25;
    }

    // Timing analysis
    const timingScore = await this.analyzeReviewTiming(appointment, new Date());
    if (timingScore > 0.8) {
      flags.push('suspicious_timing');
      riskScore += 20;
    }

    // Account analysis
    const accountAge = await this.getAccountAge(clientId);
    if (accountAge < 7) { // Less than 7 days old
      flags.push('new_account');
      riskScore += 20;
    }

    // Appointment verification
    const appointmentVerification = await this.verifyAppointmentAuthenticity(appointment);
    if (!appointmentVerification.isAuthentic) {
      flags.push('appointment_verification_failed');
      riskScore += 40;
    }

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' | 'critical';
    if (riskScore < 20) riskLevel = 'low';
    else if (riskScore < 40) riskLevel = 'medium';
    else if (riskScore < 70) riskLevel = 'high';
    else riskLevel = 'critical';

    return {
      riskScore,
      riskLevel,
      flags,
      recommendations: this.generateFraudRecommendations(flags, riskScore),
      details: {
        contentAnalysis,
        patternAnalysis: { timingPatterns: [], ratingPatterns: [], contentPatterns: [], behaviorPatterns: [] },
        userAnalysis: { accountAge, reviewHistory: userHistory.reviewCount, credibilityScore: 0, verificationLevel: 'basic', suspiciousActivity: [] },
        appointmentAnalysis: appointmentVerification
      }
    };
  }

  // Calculate verification score based on multiple factors
  async calculateVerificationScore(reviewData: CreateReviewData, appointment: any): Promise<number> {
    let score = 0;

    // Appointment completion verified (40 points)
    if (appointment.status === 'completed') {
      score += 40;
    }

    // Payment verification (30 points)
    if (appointment.paymentStatus === 'completed') {
      score += 30;
    }

    // Account verification (20 points)
    const clientVerification = await this.getClientVerificationLevel(appointment.clientId);
    if (clientVerification.emailVerified) score += 10;
    if (clientVerification.phoneVerified) score += 10;

    // Review quality indicators (10 points)
    if (reviewData.reviewText && reviewData.reviewText.length > 100) {
      score += 5;
    }
    
    if (reviewData.communicationRating || reviewData.expertiseRating) {
      score += 5; // Multi-dimensional feedback
    }

    return Math.min(score, 100);
  }

  // Get paginated reviews for a lawyer
  async getLawyerReviews(
    lawyerId: string,
    filters: ReviewFilters = {},
    page: number = 1,
    limit: number = 10
  ): Promise<PaginatedReviews> {
    try {
      const offset = (page - 1) * limit;
      
      const where: any = {
        lawyerId,
        status: ReviewStatus.PUBLISHED,
        isPublic: true
      };

      // Apply filters
      if (filters.rating) {
        where.overallRating = filters.rating;
      }
      
      if (filters.verified !== undefined) {
        where.isVerified = filters.verified;
      }
      
      if (filters.dateFrom || filters.dateTo) {
        where.publishedAt = {};
        if (filters.dateFrom) where.publishedAt.gte = filters.dateFrom;
        if (filters.dateTo) where.publishedAt.lte = filters.dateTo;
      }
      
      if (filters.caseCategory) {
        where.caseCategory = filters.caseCategory;
      }
      
      if (filters.consultationType) {
        where.consultationType = filters.consultationType;
      }

      // Build order by
      let orderBy: any = { publishedAt: 'desc' };
      if (filters.sortBy === 'rating') {
        orderBy = { overallRating: filters.sortOrder || 'desc' };
      } else if (filters.sortBy === 'helpfulness') {
        orderBy = { helpfulVotes: filters.sortOrder || 'desc' };
      }

      const [reviews, total] = await Promise.all([
        this.prisma.review.findMany({
          where,
          orderBy,
          skip: offset,
          take: limit,
          include: {
            client: {
              select: { id: true, firstName: true, lastName: true }
            },
            responses: {
              where: { status: ReviewStatus.PUBLISHED },
              select: {
                id: true,
                responseText: true,
                publishedAt: true,
                createdAt: true,
                lawyerId: true
              }
            }
          }
        }),
        this.prisma.review.count({ where })
      ]);

      return {
        reviews: reviews.map(review => this.mapToReviewListItem(review)),
        total,
        page,
        limit,
        hasNext: offset + limit < total,
        hasPrev: page > 1
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getLawyerReviews',
        lawyerId,
        filters
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to fetch lawyer reviews', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load reviews at this time'
      });
    }
  }

  async searchReviews(
    params: {
      query?: string;
      lawyerId?: string;
      page?: number;
      limit?: number;
      verifiedOnly?: boolean;
      minimumRating?: number;
    }
  ): Promise<PaginatedReviews> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const offset = (page - 1) * limit;

    if (!params.lawyerId && !params.query) {
      throw new AppError(ErrorType.VALIDATION_ERROR, 'Either lawyerId or search query is required');
    }

    const where: Prisma.ReviewWhereInput = {
      status: ReviewStatus.PUBLISHED,
      isPublic: true
    };

    if (params.lawyerId) {
      where.lawyerId = params.lawyerId;
    }

    if (params.query) {
      where.OR = [
        { reviewTitle: { contains: params.query, mode: 'insensitive' } },
        { reviewText: { contains: params.query, mode: 'insensitive' } }
      ];
    }

    if (params.verifiedOnly) {
      where.isVerified = true;
    }

    if (params.minimumRating) {
      where.overallRating = { gte: params.minimumRating } as any;
    }

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          client: {
            select: { id: true, firstName: true, lastName: true }
          },
          responses: {
            where: { status: ReviewStatus.PUBLISHED },
            select: {
              id: true,
              responseText: true,
              publishedAt: true,
              createdAt: true,
              lawyerId: true
            }
          }
        }
      }),
      this.prisma.review.count({ where })
    ]);

    return {
      reviews: reviews.map(review => this.mapToReviewListItem(review)),
      total,
      page,
      limit,
      hasNext: offset + limit < total,
      hasPrev: page > 1
    };
  }

  // Get comprehensive review statistics for a lawyer
  async getLawyerReviewStatistics(lawyerId: string): Promise<ReviewStatistics> {
    try {
      const reviewStatsDelegate = this.getReviewStatsDelegate();
      let statsRecord = reviewStatsDelegate
        ? await reviewStatsDelegate.findUnique({ where: { lawyerId } })
        : undefined;

      if (!statsRecord) {
        await this.updateLawyerRatingAggregations(lawyerId);
        statsRecord = reviewStatsDelegate
          ? await reviewStatsDelegate.findUnique({ where: { lawyerId } })
          : undefined;
      }

      if (!statsRecord || statsRecord.reviewCount === 0) {
        return this.getEmptyStatistics();
      }

      const ratingDistribution = this.normalizeRatingDistribution(statsRecord.ratingDistribution);
      const sentimentBreakdown = this.normalizeSentimentBreakdown(statsRecord.sentimentBreakdown);

      return {
        totalReviews: statsRecord.reviewCount,
        averageRating: Math.round(statsRecord.averageRating * 100) / 100,
        ratingDistribution,
        verifiedReviewPercentage: statsRecord.reviewCount > 0
          ? Math.round((statsRecord.verifiedReviewCount / statsRecord.reviewCount) * 100)
          : 0,
        recommendationPercentage: Math.round((statsRecord.recommendationRate || 0) * 100),
        responseRate: statsRecord.reviewCount > 0
          ? Math.round((statsRecord.reviewsWithResponses / statsRecord.reviewCount) * 100)
          : 0,
        averageResponseTime: Math.round(statsRecord.averageResponseTime),
        sentimentBreakdown,
        topStrengths: await this.extractTopStrengths(lawyerId),
        topWeaknesses: await this.extractTopWeaknesses(lawyerId)
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getLawyerReviewStatistics',
        lawyerId
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to calculate review statistics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load review statistics'
      });
    }
  }

  async getReviewDetail(reviewId: string, requesterId?: string): Promise<ReviewListItem> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true }
        },
        responses: {
          where: { status: ReviewStatus.PUBLISHED },
          select: {
            id: true,
            responseText: true,
            publishedAt: true,
            createdAt: true,
            lawyerId: true
          }
        }
      }
    });

    if (!review) {
      throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'The requested review could not be found'
      });
    }

    const isOwner = requesterId && review.clientId === requesterId;
    const isPublished = review.status === ReviewStatus.PUBLISHED && review.isPublic;

    if (!isPublished && !isOwner) {
      throw new AppError(ErrorType.AUTHORIZATION_ERROR, 'Access denied to review', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'You do not have permission to view this review'
      });
    }

    const mappedReview = this.mapToReviewInterface(review);

    return {
      ...mappedReview,
      client: review.client ? this.mapToClientSummary(review.client) : undefined,
      responses: Array.isArray(review.responses)
        ? review.responses.map((response: any) => this.mapToResponseSummary(response))
        : []
    };
  }

  async getPlatformReviewStatistics(): Promise<PlatformReviewStats> {
    const reviewStatsDelegate = this.getReviewStatsDelegate();

    const [statsRecords, totalLawyers, reviewsThisMonth] = await Promise.all([
      reviewStatsDelegate?.findMany ? reviewStatsDelegate.findMany() : this.prisma.review.findMany({
        where: { status: ReviewStatus.PUBLISHED, isPublic: true },
        select: {
          overallRating: true,
          isVerified: true,
          recommendsLawyer: true,
          responses: { select: { id: true }, where: { status: ReviewStatus.PUBLISHED } },
          createdAt: true,
          lawyerId: true
        }
      }),
      this.prisma.lawyerProfile.count(),
      this.prisma.review.count({
        where: {
          status: ReviewStatus.PUBLISHED,
          isPublic: true,
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        }
      })
    ]);

    if (Array.isArray(statsRecords) && statsRecords.length > 0 && 'reviewCount' in statsRecords[0]) {
      const records = statsRecords as Array<{
        reviewCount: number;
        averageRating: number;
        verifiedReviewCount: number;
        recommendationRate: number;
        reviewsWithResponses: number;
      }>;

      const totalReviews = records.reduce((sum, record) => sum + record.reviewCount, 0);
      const weightedRating = records.reduce((sum, record) => sum + record.averageRating * record.reviewCount, 0);
      const verifiedCount = records.reduce((sum, record) => sum + record.verifiedReviewCount, 0);
      const recommendedCount = records.reduce((sum, record) => sum + record.recommendationRate * record.reviewCount, 0);
      const respondedCount = records.reduce((sum, record) => sum + record.reviewsWithResponses, 0);

      return {
        totalReviews,
        averageRating: totalReviews > 0 ? Math.round((weightedRating / totalReviews) * 100) / 100 : 0,
        totalLawyers,
        reviewsThisMonth,
        verificationRate: totalReviews > 0 ? Math.round((verifiedCount / totalReviews) * 100) : 0,
        responseRate: totalReviews > 0 ? Math.round((respondedCount / totalReviews) * 100) : 0
      };
    }

    // Fallback aggregation when stats table is empty or migration pending
    if (Array.isArray(statsRecords)) {
      const reviewCount = statsRecords.length;
      const totalRating = statsRecords.reduce((sum, review: any) => sum + (review.overallRating || 0), 0);
      const verifiedCount = statsRecords.filter((review: any) => review.isVerified).length;
      const respondedCount = statsRecords.filter((review: any) => Array.isArray(review.responses) && review.responses.length > 0).length;

      return {
        totalReviews: reviewCount,
        averageRating: reviewCount > 0 ? Math.round((totalRating / reviewCount) * 100) / 100 : 0,
        totalLawyers,
        reviewsThisMonth,
        verificationRate: reviewCount > 0 ? Math.round((verifiedCount / reviewCount) * 100) : 0,
        responseRate: reviewCount > 0 ? Math.round((respondedCount / reviewCount) * 100) : 0
      };
    }

    return {
      totalReviews: 0,
      averageRating: 0,
      totalLawyers,
      reviewsThisMonth,
      verificationRate: 0,
      responseRate: 0
    };
  }

  async recalculateLawyerReviewStats(lawyerId: string): Promise<void> {
    await this.updateLawyerRatingAggregations(lawyerId);
  }

  // Update an existing review
  async updateReview(
    reviewId: string,
    updateData: UpdateReviewData,
    userId: string
  ): Promise<Review> {
    try {
      // Verify ownership
      const existingReview = await this.prisma.review.findFirst({
        where: {
          id: reviewId,
          clientId: userId
        }
      });

      if (!existingReview) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found or access denied', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Review not found or you do not have permission to edit it'
        });
      }

      // Validate update content
      const validationResult = await this.validateReviewContent(updateData as CreateReviewData);
      if (!validationResult.isValid) {
        throw new AppError(ErrorType.VALIDATION_ERROR, 'Invalid update data', {
          severity: ErrorSeverity.LOW,
          userMessage: validationResult.errors.join(', ')
        });
      }

      // Preserve original content on first edit
      const originalContent = existingReview.editCount === 0 ? existingReview.reviewText : existingReview.originalContent;

      // Check if significant changes require re-moderation
      const requiresReModeration = await this.requiresReModeration(existingReview, updateData);
      
      const updatedReview = await this.prisma.review.update({
        where: { id: reviewId },
        data: {
          ...updateData,
          editCount: existingReview.editCount + 1,
          lastEditedAt: new Date(),
          originalContent,
          moderationStatus: requiresReModeration ? ModerationStatus.PENDING : existingReview.moderationStatus,
          contentQualityScore: updateData.reviewText ? 
            await this.calculateContentQuality(updateData.reviewText) : 
            existingReview.contentQualityScore,
          sentimentScore: updateData.reviewText ? 
            await this.analyzeSentiment(updateData.reviewText) : 
            existingReview.sentimentScore
        }
      });

      // Update lawyer ratings if review is published
      if (existingReview.status === ReviewStatus.PUBLISHED) {
        await this.updateLawyerRatingAggregations(existingReview.lawyerId);
      }

      loggingService.logUserAction(`Review updated`, {
        reviewId,
        userId,
        editCount: updatedReview.editCount,
        requiresReModeration
      });

      return this.mapToReviewInterface(updatedReview);

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'updateReview',
        reviewId,
        userId
      });
      throw error;
    }
  }

  // Delete (soft delete) a review
  async deleteReview(reviewId: string, userId: string, reason?: string): Promise<void> {
    try {
      const review = await this.prisma.review.findFirst({
        where: {
          id: reviewId,
          clientId: userId
        }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found or access denied', {
          severity: ErrorSeverity.MEDIUM,
          userMessage: 'Review not found or you do not have permission to delete it'
        });
      }

      // Soft delete - hide the review but preserve for audit
      await this.prisma.review.update({
        where: { id: reviewId },
        data: {
          status: ReviewStatus.HIDDEN,
          isPublic: false,
          reviewMetadata: {
            ...(typeof review.reviewMetadata === "object" ? review.reviewMetadata : {}),
            deletedAt: new Date().toISOString(),
            deletedBy: userId,
            deletionReason: reason || 'User requested deletion'
          }
        }
      });

      // Update lawyer rating aggregations
      await this.updateLawyerRatingAggregations(review.lawyerId);

      loggingService.logUserAction(`Review deleted`, {
        reviewId,
        userId,
        lawyerId: review.lawyerId,
        reason
      });

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'deleteReview',
        reviewId,
        userId
      });
      throw error;
    }
  }

  // Helper methods
  private async getAppointmentDetails(appointmentId: string): Promise<any> {
    return await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        clientId: true,
        lawyerId: true,
        status: true,
        createdAt: true,
        paymentStatus: true
      }
    });
  }

  private async getClientReviewStatus(clientId: string): Promise<{ isBanned: boolean }> {
    // In a real implementation, check user status
    return { isBanned: false };
  }

  private async detectInappropriateContent(text: string): Promise<{ hasViolations: boolean }> {
    // Simple inappropriate content detection
    const inappropriateWords = ['spam', 'fake', 'scam']; // This would be more comprehensive
    const hasViolations = inappropriateWords.some(word => 
      text.toLowerCase().includes(word)
    );
    
    return { hasViolations };
  }

  private async analyzeReviewContent(text: string): Promise<any> {
    // Simplified content analysis
    return {
      duplicateScore: 0.1, // Would use ML/AI for real duplicate detection
      specificityScore: text.length > 100 ? 0.8 : 0.3,
      languageQuality: 0.7,
      sentimentConsistency: 0.8
    };
  }

  private async getUserReviewHistory(clientId: string): Promise<{ reviewCount: number; averageRating: number }> {
    const reviews = await this.prisma.review.findMany({
      where: { clientId },
      select: { overallRating: true }
    });

    return {
      reviewCount: reviews.length,
      averageRating: reviews.length > 0 ? 
        reviews.reduce((sum, r) => sum + r.overallRating, 0) / reviews.length : 
        0
    };
  }

  private async analyzeReviewTiming(appointment: any, reviewDate: Date): Promise<number> {
    const appointmentDate = new Date(appointment.scheduledAt);
    const daysDifference = Math.abs((reviewDate.getTime() - appointmentDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Reviews immediately after appointment might be suspicious
    if (daysDifference < 1) return 0.8;
    if (daysDifference < 7) return 0.3;
    return 0.1;
  }

  private async getAccountAge(clientId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { createdAt: true }
    });

    if (!user) return 0;
    
    return Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  }

  private async verifyAppointmentAuthenticity(appointment: any): Promise<any> {
    return {
      isAuthentic: appointment.status === 'completed',
      appointmentVerified: true,
      paymentVerified: appointment.paymentStatus === 'completed',
      consultationCompleted: appointment.status === 'completed',
      appointmentAuthenticity: 0.9
    };
  }

  private generateFraudRecommendations(flags: string[], riskScore: number): string[] {
    const recommendations: string[] = [];
    
    if (flags.includes('potential_duplicate_content')) {
      recommendations.push('Manual review recommended - potential duplicate content detected');
    }
    
    if (flags.includes('new_account')) {
      recommendations.push('Verify account authenticity before approving');
    }
    
    if (riskScore > 50) {
      recommendations.push('High fraud risk - require manual approval');
    }
    
    return recommendations;
  }

  private async getClientVerificationLevel(clientId: string): Promise<{ emailVerified: boolean; phoneVerified: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { emailVerified: true, phoneVerified: true }
    });

    return {
      emailVerified: user?.emailVerified || false,
      phoneVerified: user?.phoneVerified || false
    };
  }

  private async analyzeSentiment(text: string): Promise<number> {
    if (!text) return 0;
    
    // Simple sentiment analysis based on keywords
    const positiveWords = ['excellent', 'great', 'wonderful', 'professional', 'helpful', 'recommend'];
    const negativeWords = ['terrible', 'awful', 'unprofessional', 'rude', 'disappointed'];
    
    const words = text.toLowerCase().split(' ');
    let score = 0;
    
    words.forEach(word => {
      if (positiveWords.includes(word)) score += 0.1;
      if (negativeWords.includes(word)) score -= 0.1;
    });
    
    return Math.max(-1, Math.min(1, score));
  }

  private async calculateContentQuality(text: string): Promise<number> {
    if (!text) return 0;
    
    let score = 0;
    
    // Length bonus
    if (text.length > 100) score += 2;
    if (text.length > 300) score += 2;
    
    // Specificity indicators
    if (text.includes('specific') || text.includes('example')) score += 1;
    
    // Professional language
    if (text.includes('professional') || text.includes('knowledgeable')) score += 1;
    
    return Math.min(10, score);
  }

  private isHighQualityReview(reviewData: CreateReviewData): boolean {
    const hasDetailedText = reviewData.reviewText && reviewData.reviewText.length > 200;
    const hasMultipleDimensions = [
      reviewData.communicationRating,
      reviewData.expertiseRating,
      reviewData.responsivenessRating
    ].filter(rating => rating !== undefined).length >= 2;
    
    return Boolean(hasDetailedText && hasMultipleDimensions);
  }

  private async updateLawyerRatingAggregations(lawyerId: string): Promise<void> {
    const publishedReviews = await this.prisma.review.findMany({
      where: {
        lawyerId,
        status: ReviewStatus.PUBLISHED,
        isPublic: true
      },
      select: {
        overallRating: true,
        communicationRating: true,
        expertiseRating: true,
        responsivenessRating: true,
        valueRating: true,
        professionalismRating: true,
        isVerified: true,
        recommendsLawyer: true,
        sentimentScore: true,
        contentQualityScore: true,
        isHighQuality: true,
        publishedAt: true,
        responses: {
          where: { status: ReviewStatus.PUBLISHED },
          select: { publishedAt: true }
        }
      }
    });

    const totalReviews = publishedReviews.length;
    const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;

    let verifiedReviewCount = 0;
    let recommendationCount = 0;
    let highQualityReviewCount = 0;
    let totalSentiment = 0;
    let totalContentQuality = 0;
    let reviewsWithResponses = 0;
    let totalResponseTimeHours = 0;

    let communicationSum = 0;
    let communicationCount = 0;
    let expertiseSum = 0;
    let expertiseCount = 0;
    let responsivenessSum = 0;
    let responsivenessCount = 0;
    let valueSum = 0;
    let valueCount = 0;
    let professionalismSum = 0;
    let professionalismCount = 0;

    const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 };

    publishedReviews.forEach(review => {
      const rating = Math.min(5, Math.max(1, review.overallRating)) as 1 | 2 | 3 | 4 | 5;
      ratingDistribution[rating]++;

      if (typeof review.communicationRating === 'number') {
        communicationSum += review.communicationRating;
        communicationCount++;
      }
      if (typeof review.expertiseRating === 'number') {
        expertiseSum += review.expertiseRating;
        expertiseCount++;
      }
      if (typeof review.responsivenessRating === 'number') {
        responsivenessSum += review.responsivenessRating;
        responsivenessCount++;
      }
      if (typeof review.valueRating === 'number') {
        valueSum += review.valueRating;
        valueCount++;
      }
      if (typeof review.professionalismRating === 'number') {
        professionalismSum += review.professionalismRating;
        professionalismCount++;
      }

      if (review.isVerified) {
        verifiedReviewCount++;
      }
      if (review.recommendsLawyer) {
        recommendationCount++;
      }
      if (review.isHighQuality) {
        highQualityReviewCount++;
      }

      totalSentiment += review.sentimentScore || 0;
      totalContentQuality += review.contentQualityScore || 0;

      if (review.sentimentScore !== undefined) {
        if (review.sentimentScore > 0.1) sentimentBreakdown.positive++;
        else if (review.sentimentScore < -0.1) sentimentBreakdown.negative++;
        else sentimentBreakdown.neutral++;
      }

      if (review.responses.length > 0) {
        reviewsWithResponses++;
        const firstResponse = review.responses.reduce((earliest, current) => {
          if (!earliest) return current;
          if (!current.publishedAt) return earliest;
          if (!earliest.publishedAt || current.publishedAt < earliest.publishedAt) {
            return current;
          }
          return earliest;
        }, review.responses[0]);

        if (review.publishedAt && firstResponse?.publishedAt) {
          const diffMs = firstResponse.publishedAt.getTime() - review.publishedAt.getTime();
          if (diffMs > 0) {
            totalResponseTimeHours += diffMs / (1000 * 60 * 60);
          }
        }
      }
    });

    const averageRating = totalReviews > 0
      ? publishedReviews.reduce((sum, review) => sum + review.overallRating, 0) / totalReviews
      : 0;

    const averageResponseTime = reviewsWithResponses > 0
      ? totalResponseTimeHours / reviewsWithResponses
      : 0;

    const statsPayload = {
      averageRating,
      reviewCount: totalReviews,
      ratingDistribution,
      verifiedReviewCount,
      recommendationRate: totalReviews > 0 ? recommendationCount / totalReviews : 0,
      reviewsWithResponses,
      averageResponseTime,
      averageSentimentScore: totalReviews > 0 ? totalSentiment / totalReviews : 0,
      averageContentQualityScore: totalReviews > 0 ? totalContentQuality / totalReviews : 0,
      highQualityReviewCount,
      sentimentBreakdown,
      dimensionalAverages: {
        communication: communicationCount > 0 ? communicationSum / communicationCount : null,
        expertise: expertiseCount > 0 ? expertiseSum / expertiseCount : null,
        responsiveness: responsivenessCount > 0 ? responsivenessSum / responsivenessCount : null,
        value: valueCount > 0 ? valueSum / valueCount : null,
        professionalism: professionalismCount > 0 ? professionalismSum / professionalismCount : null
      },
      lastComputedAt: new Date()
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.lawyerProfile.update({
        where: { id: lawyerId },
        data: {
          rating: totalReviews > 0 ? averageRating : null,
          totalReviews
        }
      });

      const statsDelegate = (tx as any).lawyerReviewStats;
      if (statsDelegate) {
        await statsDelegate.upsert({
          where: { lawyerId },
          create: {
            lawyerId,
            ...statsPayload
          },
          update: {
            ...statsPayload
          }
        });
      }
    });

    await reviewAnalyticsService.recordReviewSnapshot({
      lawyerId,
      averageRating,
      reviewCount: totalReviews,
      verifiedReviewCount,
      recommendationRate: statsPayload.recommendationRate,
      reviewsWithResponses,
      averageResponseTimeHours: averageResponseTime,
      averageSentimentScore: statsPayload.averageSentimentScore,
      averageContentQualityScore: statsPayload.averageContentQualityScore,
      highQualityReviewCount,
      sentimentBreakdown,
      ratingDistribution: ratingDistribution as Record<string | number, number>
    });

    loggingService.logPerformance(`Updated rating aggregations for lawyer ${lawyerId}`, {
      lawyerId,
      operation: 'updateRatingAggregations',
      totalReviews
    });
  }

  private async requiresReModeration(existingReview: any, updateData: UpdateReviewData): Promise<boolean> {
    // Check if rating changed significantly
    if (updateData.overallRating && Math.abs(updateData.overallRating - existingReview.overallRating) > 2) {
      return true;
    }
    
    // Check if content changed significantly
    if (updateData.reviewText && existingReview.reviewText) {
      const contentChangePercentage = Math.abs(updateData.reviewText.length - existingReview.reviewText.length) / existingReview.reviewText.length;
      if (contentChangePercentage > 0.5) {
        return true;
      }
    }
    
    return false;
  }

  private getEmptyStatistics(): ReviewStatistics {
    return {
      totalReviews: 0,
      averageRating: 0,
      ratingDistribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
      verifiedReviewPercentage: 0,
      recommendationPercentage: 0,
      responseRate: 0,
      averageResponseTime: 0,
      sentimentBreakdown: { positive: 0, neutral: 0, negative: 0 },
      topStrengths: [],
      topWeaknesses: []
    };
  }

  private async calculateAverageResponseTime(lawyerId: string): Promise<number> {
    // Calculate average time between review publication and lawyer response
    const reviewsWithResponses = await this.prisma.review.findMany({
      where: {
        lawyerId,
        status: ReviewStatus.PUBLISHED,
        responses: { some: { status: ReviewStatus.PUBLISHED } }
      },
      select: {
        publishedAt: true,
        responses: {
          select: { publishedAt: true },
          where: { status: ReviewStatus.PUBLISHED },
          orderBy: { publishedAt: 'asc' },
          take: 1
        }
      }
    });

    if (reviewsWithResponses.length === 0) return 0;

    const totalHours = reviewsWithResponses.reduce((sum, review) => {
      if (review.publishedAt && review.responses[0]?.publishedAt) {
        const hours = (review.responses[0].publishedAt.getTime() - review.publishedAt.getTime()) / (1000 * 60 * 60);
        return sum + hours;
      }
      return sum;
    }, 0);

    return Math.round(totalHours / reviewsWithResponses.length);
  }

  private async extractTopStrengths(lawyerId: string): Promise<string[]> {
    // This would use NLP to extract common positive themes
    return ['Professional communication', 'Expert knowledge', 'Responsive service'];
  }

  private async extractTopWeaknesses(lawyerId: string): Promise<string[]> {
    // This would use NLP to extract common negative themes
    return [];
  }

  private getReviewStatsDelegate() {
    return (this.prisma as any).lawyerReviewStats;
  }

  private normalizeRatingDistribution(distribution: any) {
    const base = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;

    if (distribution && typeof distribution === 'object') {
      [1, 2, 3, 4, 5].forEach(r => {
        const value = (distribution as any)[r] ?? (distribution as any)[r.toString()];
        base[r as 1 | 2 | 3 | 4 | 5] = typeof value === 'number' ? value : Number(value) || 0;
      });
    }

    return base;
  }

  private normalizeSentimentBreakdown(breakdown: any) {
    const base = { positive: 0, neutral: 0, negative: 0 };

    if (breakdown && typeof breakdown === 'object') {
      (['positive', 'neutral', 'negative'] as const).forEach(key => {
        const value = (breakdown as any)[key];
        base[key] = typeof value === 'number' ? value : Number(value) || 0;
      });
    }

    return base;
  }

  private mapToClientSummary(client: any): ReviewClientSummary {
    return {
      id: client.id,
      firstName: client.firstName,
      lastName: client.lastName
    };
  }

  private mapToResponseSummary(response: any): ReviewResponseSummary {
    return {
      id: response.id,
      responseText: response.responseText,
      publishedAt: response.publishedAt ?? undefined,
      createdAt: response.createdAt,
      lawyerId: response.lawyerId
    };
  }

  private mapToReviewListItem(dbReview: any): ReviewListItem {
    const review = this.mapToReviewInterface(dbReview);

    return {
      ...review,
      client: dbReview.client ? this.mapToClientSummary(dbReview.client) : undefined,
      responses: Array.isArray(dbReview.responses)
        ? dbReview.responses.map((response: any) => this.mapToResponseSummary(response))
        : []
    };
  }

  private mapToReviewInterface(dbReview: any): Review {
    return {
      id: dbReview.id,
      appointmentId: dbReview.appointmentId,
      clientId: dbReview.clientId,
      lawyerId: dbReview.lawyerId,
      overallRating: dbReview.overallRating,
      communicationRating: dbReview.communicationRating,
      expertiseRating: dbReview.expertiseRating,
      responsivenessRating: dbReview.responsivenessRating,
      valueRating: dbReview.valueRating,
      professionalismRating: dbReview.professionalismRating,
      reviewTitle: dbReview.reviewTitle,
      reviewText: dbReview.reviewText,
      reviewLength: dbReview.reviewLength || 0,
      consultationType: dbReview.consultationType,
      caseCategory: dbReview.caseCategory,
      recommendsLawyer: dbReview.recommendsLawyer,
      isVerified: dbReview.isVerified,
      verificationMethod: dbReview.verificationMethod,
      verificationScore: dbReview.verificationScore,
      status: dbReview.status,
      moderationStatus: dbReview.moderationStatus,
      helpfulVotes: dbReview.helpfulVotes,
      unhelpfulVotes: dbReview.unhelpfulVotes,
      totalVotes: dbReview.totalVotes,
      viewCount: dbReview.viewCount,
      isHighQuality: dbReview.isHighQuality,
      sentimentScore: dbReview.sentimentScore,
      contentQualityScore: dbReview.contentQualityScore,
      editCount: dbReview.editCount,
      lastEditedAt: dbReview.lastEditedAt,
      originalContent: dbReview.originalContent,
      moderatedBy: dbReview.moderatedBy,
      moderatedAt: dbReview.moderatedAt,
      moderationNotes: dbReview.moderationNotes,
      autoModerationFlags: dbReview.autoModerationFlags || {},
      publishedAt: dbReview.publishedAt,
      isPublic: dbReview.isPublic,
      isPromoted: dbReview.isPromoted,
      isPinned: dbReview.isPinned,
      isDisputed: dbReview.isDisputed,
      disputeResolution: dbReview.disputeResolution,
      reviewMetadata: dbReview.reviewMetadata || {},
      userAgent: dbReview.userAgent,
      ipAddress: dbReview.ipAddress,
      createdAt: dbReview.createdAt,
      updatedAt: dbReview.updatedAt
    };
  }
}

export default new ReviewService();