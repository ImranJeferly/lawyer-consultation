import { ReviewService } from '../src/services/review.service';

jest.mock('../src/services/logging.service', () => ({
  __esModule: true,
  default: {
    logPerformance: jest.fn(),
    logError: jest.fn(),
    logUserAction: jest.fn()
  }
}));

jest.mock('../src/services/reviewAnalytics.service', () => ({
  __esModule: true,
  default: {
    recordReviewSnapshot: jest.fn()
  }
}));

describe('ReviewService aggregation', () => {
  it('recalculates lawyer review statistics with weighted metrics', async () => {
    const mockReviewFindMany = jest.fn();
    const mockProfileUpdate = jest.fn();
    const mockStatsUpsert = jest.fn();

    const mockPrisma: any = {
      review: {
        findMany: mockReviewFindMany
      },
      $transaction: jest.fn(async (callback: any) => {
        await callback({
          lawyerProfile: { update: mockProfileUpdate },
          lawyerReviewStats: { upsert: mockStatsUpsert }
        });
      })
    };

    const now = new Date('2025-10-01T00:00:00Z');
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    mockReviewFindMany.mockResolvedValue([
      {
        overallRating: 5,
        communicationRating: 5,
        expertiseRating: 4,
        responsivenessRating: 5,
        valueRating: 5,
        professionalismRating: 5,
        isVerified: true,
        recommendsLawyer: true,
        isHighQuality: true,
        sentimentScore: 0.8,
        contentQualityScore: 8,
        publishedAt: now,
        responses: [
          { publishedAt: twoHoursLater } as any
        ]
      },
      {
        overallRating: 4,
        communicationRating: 4,
        expertiseRating: 4,
        responsivenessRating: 4,
        valueRating: 4,
        professionalismRating: 4,
        isVerified: false,
        recommendsLawyer: false,
        isHighQuality: false,
        sentimentScore: -0.2,
        contentQualityScore: 6,
        publishedAt: now,
        responses: []
      }
    ]);

    const service = new ReviewService(mockPrisma);

    await service.recalculateLawyerReviewStats('lawyer-123');

    expect(mockReviewFindMany).toHaveBeenCalledWith({
      where: {
        lawyerId: 'lawyer-123',
        status: 'published',
        isPublic: true
      },
      select: expect.any(Object)
    });

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockProfileUpdate).toHaveBeenCalledWith({
      where: { id: 'lawyer-123' },
      data: {
        rating: expect.closeTo(4.5, 2),
        totalReviews: 2
      }
    });

    expect(mockStatsUpsert).toHaveBeenCalledTimes(1);
    const upsertPayload = mockStatsUpsert.mock.calls[0][0];
    expect(upsertPayload).toMatchObject({
      where: { lawyerId: 'lawyer-123' }
    });

    const { create, update } = upsertPayload;
    expect(create.reviewCount).toBe(2);
    expect(create.verifiedReviewCount).toBe(1);
    expect(create.recommendationRate).toBeCloseTo(0.5, 5);
    expect(create.reviewsWithResponses).toBe(1);
    expect(create.averageResponseTime).toBeCloseTo(2, 5);
    expect(create.ratingDistribution[5]).toBe(1);
    expect(create.ratingDistribution[4]).toBe(1);

    // Update payload should mirror create payload for upsert logic
    expect(update.reviewCount).toBe(create.reviewCount);
    expect(update.averageRating).toBeCloseTo(create.averageRating, 5);

    const reviewAnalyticsService = require('../src/services/reviewAnalytics.service').default as {
      recordReviewSnapshot: jest.Mock;
    };

    expect(reviewAnalyticsService.recordReviewSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      lawyerId: 'lawyer-123',
      reviewCount: 2,
      verifiedReviewCount: 1,
      recommendationRate: 0.5,
      reviewsWithResponses: 1,
      highQualityReviewCount: 1
    }));
  });
});
