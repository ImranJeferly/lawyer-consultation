// Review Routes - Working implementation for the review system
import { Router, Request, Response } from 'express';
import Joi from 'joi';
import reviewService from '../services/review.service';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';
import loggingService from '../services/logging.service';

const router = Router();

const createReviewSchema = Joi.object({
  appointmentId: Joi.string().required(),
  overallRating: Joi.number().min(1).max(5).required(),
  communicationRating: Joi.number().min(1).max(5).optional(),
  expertiseRating: Joi.number().min(1).max(5).optional(),
  responsivenessRating: Joi.number().min(1).max(5).optional(),
  valueRating: Joi.number().min(1).max(5).optional(),
  professionalismRating: Joi.number().min(1).max(5).optional(),
  reviewTitle: Joi.string().max(200).optional(),
  reviewText: Joi.string().max(5000).optional(),
  consultationType: Joi.string().optional(),
  caseCategory: Joi.string().optional(),
  recommendsLawyer: Joi.boolean().optional()
});

const updateReviewSchema = Joi.object({
  overallRating: Joi.number().min(1).max(5),
  communicationRating: Joi.number().min(1).max(5),
  expertiseRating: Joi.number().min(1).max(5),
  responsivenessRating: Joi.number().min(1).max(5),
  valueRating: Joi.number().min(1).max(5),
  professionalismRating: Joi.number().min(1).max(5),
  reviewTitle: Joi.string().max(200),
  reviewText: Joi.string().max(5000),
  recommendsLawyer: Joi.boolean()
}).min(1);

const searchReviewSchema = Joi.object({
  q: Joi.string().allow('', null),
  lawyerId: Joi.string().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  verified: Joi.boolean().truthy('true').falsy('false').optional(),
  minimumRating: Joi.number().min(1).max(5).optional()
}).or('q', 'lawyerId');

// Simple async error wrapper
const asyncHandler = (fn: any) => (req: Request, res: Response, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 1. Create a new review
router.post('/create', requireAuth, validateRequest(createReviewSchema), asyncHandler(async (req: Request, res: Response) => {
  const reviewData = req.body;
  const clientId = req.user?.id;

  if (!clientId) {
    throw new AppError(ErrorType.AUTHENTICATION_ERROR, 'User not authenticated', {
      severity: ErrorSeverity.HIGH,
      userMessage: 'Please log in to create a review'
    });
  }

  const review = await reviewService.createReview(
    reviewData,
    clientId,
    req.get('user-agent') || undefined,
    req.ip
  );

  loggingService.logUserAction('Review created', {
    reviewId: review.review.id,
    clientId,
    appointmentId: reviewData.appointmentId,
    rating: reviewData.overallRating
  });

  res.status(201).json({
    success: true,
    data: review,
    message: 'Review created successfully'
  });
}));

// 2. Get reviews for a lawyer
router.get('/lawyer/:lawyerId', asyncHandler(async (req: Request, res: Response) => {
  const { lawyerId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const filters: any = {};
  if (req.query.rating) filters.rating = parseInt(req.query.rating as string);
  if (req.query.verified) filters.verified = req.query.verified === 'true';
  if (req.query.caseCategory) filters.caseCategory = req.query.caseCategory;

  const result = await reviewService.getLawyerReviews(lawyerId, filters, page, limit);

  res.json({
    success: true,
    data: result.reviews,
    pagination: {
      page,
      limit,
      total: result.total,
      hasMore: result.hasNext,
      hasPrev: result.hasPrev
    }
  });
}));

// 3. Get review statistics for a lawyer
router.get('/lawyer/:lawyerId/stats', asyncHandler(async (req: Request, res: Response) => {
  const { lawyerId } = req.params;

  const stats = await reviewService.getLawyerReviewStatistics(lawyerId);

  res.json({
    success: true,
    data: stats,
    message: 'Review statistics retrieved successfully'
  });
}));

// 4. Update a review
router.put('/:reviewId', requireAuth, validateRequest(updateReviewSchema), asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const updateData = req.body;
  const userId = req.user?.id;

  if (!userId) {
    throw new AppError(ErrorType.AUTHENTICATION_ERROR, 'User not authenticated');
  }

  const updatedReview = await reviewService.updateReview(reviewId, updateData, userId);

  loggingService.logUserAction('Review updated', {
    reviewId,
    userId,
    changes: Object.keys(updateData)
  });

  res.json({
    success: true,
    data: updatedReview,
    message: 'Review updated successfully'
  });
}));

// 5. Delete a review
router.delete('/:reviewId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    throw new AppError(ErrorType.AUTHENTICATION_ERROR, 'User not authenticated');
  }

  await reviewService.deleteReview(reviewId, userId);

  loggingService.logUserAction('Review deleted', {
    reviewId,
    userId
  });

  res.json({
    success: true,
    message: 'Review deleted successfully'
  });
}));

// 6. Search reviews
router.get('/search', validateRequest(searchReviewSchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { q, lawyerId, page, limit, verified, minimumRating } = req.query as Record<string, string>;

  const parsedPage = page ? Number(page) : undefined;
  const parsedLimit = limit ? Number(limit) : undefined;
  const parsedMinimumRating = minimumRating !== undefined && minimumRating !== null && minimumRating !== ''
    ? Number(minimumRating)
    : undefined;

  const result = await reviewService.searchReviews({
    query: q || undefined,
    lawyerId: lawyerId || undefined,
    page: Number.isFinite(parsedPage) ? parsedPage : undefined,
    limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    verifiedOnly: verified ? verified === 'true' : undefined,
    minimumRating: Number.isFinite(parsedMinimumRating) ? parsedMinimumRating : undefined
  });

  res.json({
    success: true,
    data: result.reviews,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      hasMore: result.hasNext,
      hasPrev: result.hasPrev
    },
    message: 'Search completed successfully'
  });
}));

// 7. Get review details
router.get('/:reviewId', asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;

  const review = await reviewService.getReviewDetail(reviewId, req.user?.id);

  res.json({
    success: true,
    data: review,
    message: 'Review details retrieved successfully'
  });
}));

// 8. Get platform statistics
router.get('/platform/stats', asyncHandler(async (req: Request, res: Response) => {
  const stats = await reviewService.getPlatformReviewStatistics();

  res.json({
    success: true,
    data: stats,
    message: 'Platform statistics retrieved successfully'
  });
}));

// Error handling middleware
router.use((error: Error, req: Request, res: Response, next: Function) => {
  loggingService.logError(error, req, {
    route: req.path,
    method: req.method,
    params: req.params,
    query: req.query
  });

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: {
        type: error.type,
        message: error.userMessage || error.message,
        severity: error.severity
      }
    });
  }

  // Default error response
  res.status(500).json({
    success: false,
    error: {
      type: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  });
});

export default router;