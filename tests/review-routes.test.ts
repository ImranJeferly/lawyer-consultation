import express from 'express';
import request from 'supertest';
import reviewRoutes from '../src/routes/review.routes';

jest.mock('../src/services/review.service', () => ({
  __esModule: true,
  default: {
    createReview: jest.fn(),
    getLawyerReviews: jest.fn(),
    getLawyerReviewStatistics: jest.fn(),
    updateReview: jest.fn(),
    deleteReview: jest.fn(),
    searchReviews: jest.fn(),
    getReviewDetail: jest.fn(),
    getPlatformReviewStatistics: jest.fn()
  }
}));

jest.mock('../src/middleware/auth.middleware', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => next()
}));

jest.mock('../src/services/logging.service', () => ({
  __esModule: true,
  default: {
    logError: jest.fn(),
    logPerformance: jest.fn(),
    logUserAction: jest.fn()
  }
}));

const app = express();
app.use(express.json());
app.use('/reviews', reviewRoutes);

const reviewServiceMock = require('../src/services/review.service').default as {
  createReview: jest.Mock;
  getLawyerReviews: jest.Mock;
  getLawyerReviewStatistics: jest.Mock;
  updateReview: jest.Mock;
  deleteReview: jest.Mock;
  searchReviews: jest.Mock;
  getReviewDetail: jest.Mock;
  getPlatformReviewStatistics: jest.Mock;
};

describe('Review routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns validation error when missing search parameters', async () => {
    const response = await request(app).get('/reviews/search');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(reviewServiceMock.searchReviews).not.toHaveBeenCalled();
  });

  it('searches reviews when query provided', async () => {
    reviewServiceMock.searchReviews.mockResolvedValue({
      reviews: [{ id: 'rev-1' }],
      page: 1,
      limit: 10,
      total: 1,
      hasNext: false,
      hasPrev: false
    });

    const response = await request(app)
      .get('/reviews/search')
      .query({ q: 'great', page: 1, limit: 10 });

    expect(response.status).toBe(200);
    expect(reviewServiceMock.searchReviews).toHaveBeenCalledWith({
      query: 'great',
      lawyerId: undefined,
      page: 1,
      limit: 10,
      verifiedOnly: undefined,
      minimumRating: undefined
    });
    expect(response.body.data).toEqual([{ id: 'rev-1' }]);
    expect(response.body.pagination).toMatchObject({
      page: 1,
      limit: 10,
      total: 1,
      hasMore: false,
      hasPrev: false
    });
  });

  it('returns review detail', async () => {
    reviewServiceMock.getReviewDetail.mockResolvedValue({ id: 'rev-1', overallRating: 4.5 });

    const response = await request(app).get('/reviews/rev-1');

    expect(response.status).toBe(200);
  expect(reviewServiceMock.getReviewDetail).toHaveBeenCalledWith('rev-1', undefined);
    expect(response.body.data).toEqual({ id: 'rev-1', overallRating: 4.5 });
  });

  it('returns platform review statistics', async () => {
    reviewServiceMock.getPlatformReviewStatistics.mockResolvedValue({ averageRating: 4.2, totalReviews: 100 });

    const response = await request(app).get('/reviews/platform/stats');

    expect(response.status).toBe(200);
  expect(reviewServiceMock.getPlatformReviewStatistics).toHaveBeenCalledTimes(1);
    expect(response.body.data).toEqual({ averageRating: 4.2, totalReviews: 100 });
  });
});
