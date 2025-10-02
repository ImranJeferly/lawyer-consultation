// Review Analytics Service - Handles review analytics, statistics, and insights
import { Prisma, PrismaClient } from '@prisma/client';
import loggingService, { LogCategory, LogLevel } from './logging.service';
import alertNotificationService from './alertNotification.service';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

interface ReviewAnalytics {
  totalReviews: number;
  averageRating: number;
  ratingDistribution: { [rating: number]: number };
  responseRate: number;
  averageResponseTime: number;
  verificationRate: number;
  helpfulnessScore: number;
  sentimentDistribution: {
    positive: number;
    neutral: number;
    negative: number;
  };
  monthlyTrends: Array<{
    month: string;
    reviews: number;
    averageRating: number;
  }>;
  topPracticeAreas: Array<{
    area: string;
    count: number;
    averageRating: number;
  }>;
}

interface LawyerAnalytics extends ReviewAnalytics {
  improvementSuggestions: string[];
  competitorComparison?: {
    averageInArea: number;
    percentile: number;
  };
}

export interface ReviewSnapshotPayload {
  lawyerId: string;
  averageRating: number;
  reviewCount: number;
  verifiedReviewCount: number;
  recommendationRate: number;
  reviewsWithResponses: number;
  averageResponseTimeHours: number;
  averageSentimentScore: number;
  averageContentQualityScore: number;
  highQualityReviewCount: number;
  sentimentBreakdown: Record<string, number>;
  ratingDistribution: Record<string | number, number>;
}

class ReviewAnalyticsService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async recordReviewSnapshot(snapshot: ReviewSnapshotPayload): Promise<void> {
    try {
      await Promise.all([
        this.recordMetric('review.average_rating', snapshot, snapshot.averageRating, 'rating'),
        this.recordMetric('review.recommendation_rate', snapshot, snapshot.recommendationRate, 'ratio'),
        this.recordMetric('review.response_time_hours', snapshot, snapshot.averageResponseTimeHours, 'hours'),
        this.recordMetric('review.sentiment_score', snapshot, snapshot.averageSentimentScore, 'score'),
        this.recordMetric('review.review_count', snapshot, snapshot.reviewCount, 'count')
      ]);

      await this.evaluateReviewHealth(snapshot);
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'reviewAnalytics.recordReviewSnapshot',
        lawyerId: snapshot.lawyerId
      });
    }
  }

  private async recordMetric(
    metricName: string,
    snapshot: ReviewSnapshotPayload,
    value: number,
    unit: string
  ): Promise<void> {
    try {
      await this.prisma.systemMetrics.create({
        data: {
          metricName,
          metricType: 'gauge',
          component: 'review-service',
          value: this.requiredDecimal(value),
          unit,
          tags: {
            lawyerId: snapshot.lawyerId
          },
          dimensions: {
            reviewCount: snapshot.reviewCount,
            verifiedReviewCount: snapshot.verifiedReviewCount
          },
          granularity: 'hour',
          createdAt: new Date()
        }
      });
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'reviewAnalytics.recordMetric',
        metricName,
        lawyerId: snapshot.lawyerId
      });
    }
  }

  private async evaluateReviewHealth(snapshot: ReviewSnapshotPayload): Promise<void> {
    const alerts: Array<{
      title: string;
      description: string;
      severity: 'warning' | 'critical';
      metricName: string;
      threshold: number;
      actualValue: number;
      condition: string;
    }> = [];

    if (snapshot.reviewCount >= 10 && snapshot.averageRating <= 3) {
      alerts.push({
        title: 'Average rating degradation detected',
        description: `Average rating dropped to ${snapshot.averageRating.toFixed(2)} across ${snapshot.reviewCount} reviews`,
        severity: 'critical',
        metricName: 'review.average_rating',
        threshold: 3,
        actualValue: snapshot.averageRating,
        condition: 'average_rating <= 3 for review_count >= 10'
      });
    }

    if (snapshot.reviewCount >= 5 && snapshot.recommendationRate < 0.4) {
      alerts.push({
        title: 'Low recommendation rate detected',
        description: `Only ${(snapshot.recommendationRate * 100).toFixed(1)}% of clients recommend this lawyer`,
        severity: 'warning',
        metricName: 'review.recommendation_rate',
        threshold: 0.4,
        actualValue: snapshot.recommendationRate,
        condition: 'recommendation_rate < 0.4 for review_count >= 5'
      });
    }

    if (snapshot.reviewsWithResponses >= 3 && snapshot.averageResponseTimeHours > 72) {
      alerts.push({
        title: 'Slow review response time',
        description: `Average response time is ${snapshot.averageResponseTimeHours.toFixed(1)} hours`,
        severity: 'warning',
        metricName: 'review.response_time_hours',
        threshold: 72,
        actualValue: snapshot.averageResponseTimeHours,
        condition: 'average_response_time_hours > 72 with >= 3 responded reviews'
      });
    }

    await Promise.all(alerts.map((alert) => this.createAlert(snapshot, alert)));
  }

  private async createAlert(
    snapshot: ReviewSnapshotPayload,
    alert: {
      title: string;
      description: string;
      severity: 'warning' | 'critical';
      metricName: string;
      threshold: number;
      actualValue: number;
      condition: string;
    }
  ): Promise<void> {
    try {
      const ratingDistributionJson = Object.fromEntries(
        Object.entries(snapshot.ratingDistribution).map(([key, value]) => [String(key), value])
      ) as Prisma.JsonObject;

      const sentimentBreakdownJson = Object.fromEntries(
        Object.entries(snapshot.sentimentBreakdown).map(([key, value]) => [String(key), value])
      ) as Prisma.JsonObject;

      const snapshotJson: Prisma.JsonObject = {
        averageRating: snapshot.averageRating,
        reviewCount: snapshot.reviewCount,
        verifiedReviewCount: snapshot.verifiedReviewCount,
        recommendationRate: snapshot.recommendationRate,
        reviewsWithResponses: snapshot.reviewsWithResponses,
        averageResponseTimeHours: snapshot.averageResponseTimeHours,
        averageSentimentScore: snapshot.averageSentimentScore,
        averageContentQualityScore: snapshot.averageContentQualityScore,
        highQualityReviewCount: snapshot.highQualityReviewCount
      };

      const metadata: Prisma.JsonObject = {
        lawyerId: snapshot.lawyerId,
        snapshot: snapshotJson,
        ratingDistribution: ratingDistributionJson,
        sentimentBreakdown: sentimentBreakdownJson
      };

      const createdAlert = await this.prisma.systemAlerts.create({
        data: {
          alertName: `${alert.metricName}:${snapshot.lawyerId}:${Date.now()}`,
          alertType: 'lawyer_review_health',
          severity: alert.severity,
          title: alert.title,
          description: alert.description,
          component: 'review-service',
          metricName: alert.metricName,
          threshold: this.requiredDecimal(alert.threshold),
          actualValue: this.requiredDecimal(alert.actualValue),
          condition: alert.condition,
          status: 'active',
          triggeredAt: new Date(),
          firstOccurrence: new Date(),
          lastOccurrence: new Date(),
          occurrenceCount: 1,
          affectedUsers: snapshot.reviewCount,
          alertMetadata: metadata,
          tags: {
            lawyerId: snapshot.lawyerId,
            metric: alert.metricName
          }
        }
      });

      loggingService.log(LogLevel.WARN, LogCategory.SYSTEM, 'Review health alert created', {
        lawyerId: snapshot.lawyerId,
        metric: alert.metricName,
        actualValue: alert.actualValue,
        threshold: alert.threshold
      });

      await alertNotificationService.notifyNewSystemAlert(createdAlert);
    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'reviewAnalytics.createAlert',
        lawyerId: snapshot.lawyerId,
        metric: alert.metricName
      });
    }
  }

  private requiredDecimal(value: number): Prisma.Decimal {
    return new Prisma.Decimal(value ?? 0);
  }

  // Get comprehensive analytics for a lawyer
  async getLawyerAnalytics(
    lawyerId: string,
    timeframe: 'all' | '30d' | '90d' | '1y' = '90d'
  ): Promise<LawyerAnalytics> {
    try {
      const whereClause = this.buildTimeframeWhere(lawyerId, timeframe);

      const [
        reviews,
        totalReviews,
        responses,
        totalResponses
      ] = await Promise.all([
        this.prisma.review.findMany({
          where: whereClause,
          include: {
            responses: true,
            helpfulness: true
          }
        }),
        this.prisma.review.count({ where: whereClause }),
        this.prisma.reviewResponse.findMany({
          where: {
            lawyerId,
            status: 'published',
            ...this.getTimeframeFilter(timeframe)
          }
        }),
        this.prisma.reviewResponse.count({
          where: { lawyerId, status: 'published' }
        })
      ]);

      // Calculate basic metrics
      const totalRating = reviews.reduce((sum, r) => sum + r.overallRating, 0);
      const averageRating = totalReviews > 0 ? totalRating / totalReviews : 0;

      // Rating distribution
      const ratingDistribution = this.calculateRatingDistribution(reviews);

      // Response metrics
      const responseRate = totalReviews > 0 ? (totalResponses / totalReviews) * 100 : 0;
      const averageResponseTime = await this.calculateAverageResponseTime(lawyerId, timeframe);

      // Verification rate
      const verifiedReviews = reviews.filter(r => r.isVerified).length;
      const verificationRate = totalReviews > 0 ? (verifiedReviews / totalReviews) * 100 : 0;

      // Helpfulness score
      const helpfulnessScore = this.calculateHelpfulnessScore(reviews);

      // Sentiment analysis
      const sentimentDistribution = await this.analyzeSentimentDistribution(reviews);

      // Monthly trends
      const monthlyTrends = this.calculateMonthlyTrends(reviews);

      // Practice area breakdown
      const topPracticeAreas = await this.getTopPracticeAreas(lawyerId, timeframe);

      // Improvement suggestions
      const improvementSuggestions = this.generateImprovementSuggestions({
        averageRating,
        responseRate,
        helpfulnessScore,
        verificationRate,
        reviews
      });

      return {
        totalReviews,
        averageRating: Math.round(averageRating * 100) / 100,
        ratingDistribution,
        responseRate: Math.round(responseRate),
        averageResponseTime,
        verificationRate: Math.round(verificationRate),
        helpfulnessScore: Math.round(helpfulnessScore * 100) / 100,
        sentimentDistribution,
        monthlyTrends,
        topPracticeAreas,
        improvementSuggestions
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getLawyerAnalytics',
        lawyerId,
        timeframe
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get lawyer analytics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load analytics data'
      });
    }
  }

  // Get platform-wide review analytics
  async getPlatformAnalytics(timeframe: 'all' | '30d' | '90d' | '1y' = '90d'): Promise<ReviewAnalytics> {
    try {
      const whereClause = this.buildTimeframeWhere(null, timeframe);

      const [
        reviews,
        totalReviews,
        totalResponses
      ] = await Promise.all([
        this.prisma.review.findMany({
          where: whereClause,
          include: {
            responses: true,
            helpfulness: true
          }
        }),
        this.prisma.review.count({ where: whereClause }),
        this.prisma.reviewResponse.count({
          where: {
            status: 'published',
            ...this.getTimeframeFilter(timeframe)
          }
        })
      ]);

      // Calculate metrics
      const totalRating = reviews.reduce((sum, r) => sum + r.overallRating, 0);
      const averageRating = totalReviews > 0 ? totalRating / totalReviews : 0;
      const ratingDistribution = this.calculateRatingDistribution(reviews);
      const responseRate = totalReviews > 0 ? (totalResponses / totalReviews) * 100 : 0;
      const averageResponseTime = await this.calculateAverageResponseTime(null, timeframe);
      
      const verifiedReviews = reviews.filter(r => r.isVerified).length;
      const verificationRate = totalReviews > 0 ? (verifiedReviews / totalReviews) * 100 : 0;
      
      const helpfulnessScore = this.calculateHelpfulnessScore(reviews);
      const sentimentDistribution = await this.analyzeSentimentDistribution(reviews);
      const monthlyTrends = this.calculateMonthlyTrends(reviews);
      const topPracticeAreas = await this.getTopPracticeAreas(null, timeframe);

      return {
        totalReviews,
        averageRating: Math.round(averageRating * 100) / 100,
        ratingDistribution,
        responseRate: Math.round(responseRate),
        averageResponseTime,
        verificationRate: Math.round(verificationRate),
        helpfulnessScore: Math.round(helpfulnessScore * 100) / 100,
        sentimentDistribution,
        monthlyTrends,
        topPracticeAreas
      };

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getPlatformAnalytics',
        timeframe
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get platform analytics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load platform analytics'
      });
    }
  }

  // Get review insights for a specific review
  async getReviewInsights(reviewId: string): Promise<any> {
    try {
      const review = await this.prisma.review.findUnique({
        where: { id: reviewId },
        include: {
          responses: true,
          helpfulness: true,
          flags: true,
          disputes: true
        }
      });

      if (!review) {
        throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found');
      }

      const insights = {
        engagementScore: this.calculateEngagementScore(review),
        qualityIndicators: this.analyzeQualityIndicators(review),
        impactMetrics: await this.calculateImpactMetrics(reviewId),
        trendAnalysis: await this.analyzeTrends(review.lawyerId, review.createdAt),
        recommendations: this.generateReviewRecommendations(review)
      };

      return insights;

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getReviewInsights',
        reviewId
      });
      throw error;
    }
  }

  // Get comparative analytics between lawyers
  async getComparativeAnalytics(
    lawyerIds: string[],
    timeframe: 'all' | '30d' | '90d' | '1y' = '90d'
  ): Promise<any> {
    try {
      const comparisons = await Promise.all(
        lawyerIds.map(async (lawyerId) => {
          const analytics = await this.getLawyerAnalytics(lawyerId, timeframe);
          return {
            lawyerId,
            ...analytics
          };
        })
      );

      // Calculate comparative metrics
      const averageRatings = comparisons.map(c => c.averageRating);
      const responsRates = comparisons.map(c => c.responseRate);
      
      const insights = {
        comparisons,
        benchmarks: {
          averageRating: {
            min: Math.min(...averageRatings),
            max: Math.max(...averageRatings),
            avg: averageRatings.reduce((sum, r) => sum + r, 0) / averageRatings.length
          },
          responseRate: {
            min: Math.min(...responsRates),
            max: Math.max(...responsRates),
            avg: responsRates.reduce((sum, r) => sum + r, 0) / responsRates.length
          }
        },
        rankings: this.calculateRankings(comparisons)
      };

      return insights;

    } catch (error) {
      loggingService.logError(error as Error, undefined, {
        operation: 'getComparativeAnalytics',
        lawyerIds,
        timeframe
      });
      throw new AppError(ErrorType.DATABASE_ERROR, 'Failed to get comparative analytics', {
        severity: ErrorSeverity.MEDIUM,
        userMessage: 'Could not load comparative analytics'
      });
    }
  }

  // Helper methods
  private buildTimeframeWhere(lawyerId: string | null, timeframe: string): any {
    const base: any = lawyerId ? { lawyerId } : {};
    
    if (timeframe !== 'all') {
      base.createdAt = { gte: this.getTimeframeStart(timeframe) };
    }
    
    return base;
  }

  private getTimeframeFilter(timeframe: string): any {
    if (timeframe === 'all') return {};
    return { createdAt: { gte: this.getTimeframeStart(timeframe) } };
  }

  private getTimeframeStart(timeframe: string): Date {
    const now = new Date();
    switch (timeframe) {
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      case '1y':
        return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      default:
        return new Date(0);
    }
  }

  private calculateRatingDistribution(reviews: any[]): { [rating: number]: number } {
    const distribution: { [rating: number]: number } = {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0
    };

    reviews.forEach(review => {
      const rating = Math.floor(review.overallRating);
      if (rating >= 1 && rating <= 5) {
        distribution[rating]++;
      }
    });

    return distribution;
  }

  private async calculateAverageResponseTime(lawyerId: string | null, timeframe: string): Promise<number> {
    const where: any = timeframe !== 'all' ? 
      { createdAt: { gte: this.getTimeframeStart(timeframe) } } : {};
    
    if (lawyerId) {
      where.lawyerId = lawyerId;
    }

    const responses = await this.prisma.reviewResponse.findMany({
      where,
      include: {
        review: {
          select: {
            publishedAt: true,
            createdAt: true
          }
        }
      }
    });

    if (responses.length === 0) return 0;

    const responseTimes = responses
      .filter(r => r.review.publishedAt && r.publishedAt)
      .map(r => {
        const reviewTime = r.review.publishedAt!.getTime();
        const responseTime = r.publishedAt!.getTime();
        return (responseTime - reviewTime) / (1000 * 60 * 60); // hours
      });

    return responseTimes.length > 0 ? 
      Math.round(responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length) : 0;
  }

  private calculateHelpfulnessScore(reviews: any[]): number {
    const totalVotes = reviews.reduce((sum, r) => sum + r.totalVotes, 0);
    const helpfulVotes = reviews.reduce((sum, r) => sum + r.helpfulVotes, 0);
    
    return totalVotes > 0 ? (helpfulVotes / totalVotes) * 5 : 0;
  }

  private async analyzeSentimentDistribution(reviews: any[]): Promise<{
    positive: number;
    neutral: number;
    negative: number;
  }> {
    let positive = 0, neutral = 0, negative = 0;

    reviews.forEach(review => {
      const sentiment = review.sentimentScore || 0;
      if (sentiment > 0.1) positive++;
      else if (sentiment < -0.1) negative++;
      else neutral++;
    });

    const total = reviews.length || 1;
    return {
      positive: Math.round((positive / total) * 100),
      neutral: Math.round((neutral / total) * 100),
      negative: Math.round((negative / total) * 100)
    };
  }

  private calculateMonthlyTrends(reviews: any[]): Array<{
    month: string;
    reviews: number;
    averageRating: number;
  }> {
    const monthlyData: { [month: string]: { count: number; totalRating: number } } = {};

    reviews.forEach(review => {
      const month = review.createdAt.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyData[month]) {
        monthlyData[month] = { count: 0, totalRating: 0 };
      }
      monthlyData[month].count++;
      monthlyData[month].totalRating += review.overallRating;
    });

    return Object.entries(monthlyData)
      .map(([month, data]) => ({
        month,
        reviews: data.count,
        averageRating: Math.round((data.totalRating / data.count) * 100) / 100
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  private async getTopPracticeAreas(lawyerId: string | null, timeframe: string): Promise<Array<{
    area: string;
    count: number;
    averageRating: number;
  }>> {
    // This would need to be implemented based on how practice areas
    // are connected to reviews in your specific schema
    return [
      { area: 'Family Law', count: 5, averageRating: 4.2 },
      { area: 'Criminal Defense', count: 3, averageRating: 4.7 },
      { area: 'Personal Injury', count: 8, averageRating: 4.1 }
    ];
  }

  private generateImprovementSuggestions(metrics: any): string[] {
    const suggestions: string[] = [];

    if (metrics.averageRating < 4.0) {
      suggestions.push('Focus on improving service quality to increase ratings');
    }

    if (metrics.responseRate < 50) {
      suggestions.push('Respond to more reviews to show client engagement');
    }

    if (metrics.helpfulnessScore < 3.0) {
      suggestions.push('Write more detailed and helpful responses');
    }

    if (metrics.verificationRate < 80) {
      suggestions.push('Encourage clients to verify their reviews');
    }

    // Analyze review content for specific issues
    const lowRatingReviews = metrics.reviews?.filter((r: any) => r.overallRating <= 2) || [];
    if (lowRatingReviews.length > 0) {
      suggestions.push('Address communication issues mentioned in low-rating reviews');
    }

    return suggestions;
  }

  private calculateEngagementScore(review: any): number {
    let score = 0;
    
    // Base score from helpfulness votes
    score += review.helpfulVotes * 2;
    score += review.totalVotes * 0.5;
    
    // Response engagement
    if (review.responses?.length > 0) {
      score += 5;
      score += review.responses.reduce((sum: number, r: any) => sum + r.helpfulVotes, 0);
    }
    
    // View engagement
    score += Math.min(review.viewCount * 0.1, 10);
    
    return Math.min(score, 100);
  }

  private analyzeQualityIndicators(review: any): any {
    return {
      isVerified: review.isVerified,
      hasDetailed: (review.reviewText?.length || 0) > 100,
      hasMultipleDimensions: [
        review.communicationRating,
        review.expertiseRating,
        review.responsivenessRating
      ].filter(r => r !== null).length > 1,
      contentQuality: review.contentQualityScore || 0,
      authenticity: review.verificationScore || 0
    };
  }

  private async calculateImpactMetrics(reviewId: string): Promise<any> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId }
    });

    return {
      viewImpact: review?.viewCount || 0,
      helpfulnessImpact: review?.helpfulVotes || 0,
      responseGenerated: false, // Would need to check responses separately
      influenceScore: ((review?.helpfulVotes || 0) * 2) + ((review?.viewCount || 0) * 0.1)
    };
  }

  private async analyzeTrends(lawyerId: string, reviewDate: Date): Promise<any> {
    // Get reviews before and after this review to analyze trends
    const [before, after] = await Promise.all([
      this.prisma.review.findMany({
        where: {
          lawyerId,
          createdAt: { lt: reviewDate }
        },
        orderBy: { createdAt: 'desc' },
        take: 5
      }),
      this.prisma.review.findMany({
        where: {
          lawyerId,
          createdAt: { gt: reviewDate }
        },
        orderBy: { createdAt: 'asc' },
        take: 5
      })
    ]);

    const beforeAvg = before.length > 0 ? 
      before.reduce((sum, r) => sum + r.overallRating, 0) / before.length : 0;
    const afterAvg = after.length > 0 ? 
      after.reduce((sum, r) => sum + r.overallRating, 0) / after.length : 0;

    return {
      beforeAverage: beforeAvg,
      afterAverage: afterAvg,
      trendDirection: afterAvg > beforeAvg ? 'improving' : afterAvg < beforeAvg ? 'declining' : 'stable'
    };
  }

  private generateReviewRecommendations(review: any): string[] {
    const recommendations: string[] = [];

    if (review.overallRating <= 2 && !review.responses?.length) {
      recommendations.push('Consider responding to this low-rating review professionally');
    }

    if (review.helpfulVotes === 0 && review.viewCount > 50) {
      recommendations.push('This review has high visibility but low engagement');
    }

    if (!review.isVerified && review.verificationScore < 0.7) {
      recommendations.push('This review may need verification');
    }

    return recommendations;
  }

  private calculateRankings(comparisons: any[]): any {
    return {
      byRating: [...comparisons].sort((a, b) => b.averageRating - a.averageRating),
      byResponseRate: [...comparisons].sort((a, b) => b.responseRate - a.responseRate),
      byTotalReviews: [...comparisons].sort((a, b) => b.totalReviews - a.totalReviews)
    };
  }
}

export default new ReviewAnalyticsService();