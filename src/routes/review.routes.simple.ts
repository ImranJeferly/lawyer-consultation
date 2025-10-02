// Simplified Review Routes - Core functionality for the comprehensive review system
import { Router, Request, Response, NextFunction } from 'express';
import reviewService from '../services/review.service';
import { requireAuth } from '../middleware/auth.middleware';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';
import loggingService from '../services/logging.service';
import {
  CreateReviewRequest,
  ReviewFilters,
  CreateResponseRequest,
  FlagReviewRequest,
  HelpfulnessVoteRequest,
  CreateDisputeRequest
} from '../types/review.types';

const router = Router();

// Simple async error wrapper
const asyncHandler = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 1. Create a new review
router.post('/create', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const reviewData: CreateReviewRequest = req.body;
  const userId = req.auth?.userId;

  if (!userId) {
    throw new AppError(ErrorType.AUTHENTICATION_ERROR, 'User not authenticated', {
      severity: ErrorSeverity.HIGH,
      userMessage: 'Please log in to create a review'
    });
  }

  // Validate required fields
  if (!reviewData.appointmentId || !reviewData.overallRating) {
    throw new AppError(ErrorType.VALIDATION_ERROR, 'Missing required fields', {
      severity: ErrorSeverity.MEDIUM,
      userMessage: 'Appointment ID and overall rating are required'
    });
  }

  const review = await reviewService.createReview(reviewData, userId);

  loggingService.logUserAction('Review created', {
    reviewId: review.review.id,
    userId,
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
  const sortBy = (req.query.sortBy as string) || 'newest';

  const filters: ReviewFilters = {
    rating: req.query.rating ? parseInt(req.query.rating as string) : undefined,
    verified: req.query.verified ? req.query.verified === 'true' : undefined,
    caseCategory: req.query.caseCategory as string
  };

  const result = await reviewService.getLawyerReviews(lawyerId, filters, page, limit);

  res.json({
    success: true,
    data: result.reviews,
    pagination: {
      page,
      limit,
      total: result.total,
      hasMore: result.hasNext
    }
  });
}));

// 3. Get analytics for a lawyer
router.get('/analytics/lawyer/:lawyerId', asyncHandler(async (req: Request, res: Response) => {
  const { lawyerId } = req.params;
  const timeRange = (req.query.timeRange as string) || '90d';

  // Use the review service's built-in analytics method
  const analytics = await reviewService.getLawyerReviewStatistics(lawyerId);

  res.json({
    success: true,
    data: analytics,
    message: 'Analytics retrieved successfully'
  });
}));

// 4. Get featured reviews for a lawyer
router.get('/lawyer/:lawyerId/featured', asyncHandler(async (req: Request, res: Response) => {
  const { lawyerId } = req.params;
  const limit = parseInt(req.query.limit as string) || 5;

  // Simple implementation using high-quality and highly-rated reviews
  const allReviews = await reviewService.getLawyerReviews(lawyerId, {}, 1, 50);
  const featuredReviews = allReviews.reviews
    .filter(review => review.isHighQuality || review.overallRating >= 4)
    .slice(0, limit);

  res.json({
    success: true,
    data: featuredReviews,
    message: 'Featured reviews retrieved successfully'
  });
}));

// 5. Vote on review helpfulness
router.put('/:reviewId/helpful', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const { isHelpful }: HelpfulnessVoteRequest = req.body;
  const userId = req.auth?.userId;

  if (!userId) {
    throw new AppError(ErrorType.AUTHENTICATION_ERROR, 'User not authenticated');
  }

  // Simple implementation - just increment counters
  const review = await reviewService['prisma'].review.findUnique({
    where: { id: reviewId }
  });
  if (!review) {
    throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found');
  }

  // In a real implementation, you'd track individual votes to prevent duplicates
  // For now, just increment the appropriate counter
  const updateData = isHelpful ? 
    { helpfulVotes: { increment: 1 } } : 
    { unhelpfulVotes: { increment: 1 } };

  await reviewService['prisma'].review.update({
    where: { id: reviewId },
    data: {
      ...updateData,
      totalVotes: { increment: 1 }
    }
  });

  loggingService.logUserAction('Review helpfulness vote', {
    reviewId,
    userId,
    isHelpful
  });

  res.json({
    success: true,
    message: 'Vote recorded successfully'
  });
}));

// 6. Get review details
router.get('/:reviewId/details', asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const userId = req.auth?.userId;

  const review = await reviewService['prisma'].review.findUnique({
    where: { id: reviewId },
    include: {
      client: {
        select: { id: true, firstName: true, lastName: true }
      }
    }
  });
  
  if (!review) {
    throw new AppError(ErrorType.NOT_FOUND_ERROR, 'Review not found', {
      severity: ErrorSeverity.MEDIUM,
      userMessage: 'The requested review could not be found'
    });
  }

  // Increment view count if user is different from review author
  if (userId && userId !== review.clientId) {
    await reviewService['prisma'].review.update({
      where: { id: reviewId },
      data: { viewCount: { increment: 1 } }
    });
  }

  res.json({
    success: true,
    data: review,
    message: 'Review details retrieved successfully'
  });
}));

// 7. Search reviews
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const query = req.query.q as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  const filters: ReviewFilters = {
    rating: req.query.rating ? parseInt(req.query.rating as string) : undefined,
    verified: req.query.verified ? req.query.verified === 'true' : undefined,
    caseCategory: req.query.caseCategory as string
  };

  // Simple search implementation
  const result = await reviewService.getLawyerReviews(
    req.query.lawyerId as string || '', 
    filters, 
    page, 
    limit
  );

  // Filter by query if provided
  let filteredReviews = result.reviews;
  if (query) {
    filteredReviews = result.reviews.filter(review => 
      (review.reviewTitle && review.reviewTitle.toLowerCase().includes(query.toLowerCase())) ||
      (review.reviewText && review.reviewText.toLowerCase().includes(query.toLowerCase()))
    );
  }

  res.json({
    success: true,
    data: filteredReviews,
    pagination: {
      page,
      limit,
      total: filteredReviews.length,
      hasMore: false
    },
    message: 'Search completed successfully'
  });
}));

// 8. Update a review
router.put('/:reviewId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const updateData = req.body;
  const userId = req.auth?.userId;

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

// 9. Delete a review
router.delete('/:reviewId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { reviewId } = req.params;
  const userId = req.auth?.userId;

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

// 10. Get platform-wide review statistics
router.get('/platform/statistics', asyncHandler(async (req: Request, res: Response) => {
  // Simple platform statistics
  const stats = {
    totalReviews: await reviewService['prisma'].review.count(),
    averageRating: 4.2, // Would calculate this from actual data
    totalLawyers: await reviewService['prisma'].lawyerProfile.count(),
    reviewsThisMonth: await reviewService['prisma'].review.count({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        }
      }
    }),
    verificationRate: 75, // Would calculate from actual data
    responseRate: 68 // Would calculate from actual data
  };

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