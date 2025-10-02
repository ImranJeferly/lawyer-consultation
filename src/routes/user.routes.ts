import { Router, Request, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import prisma from '../config/database';
import { authenticateClerk } from '../middleware/auth.middleware';
import { updateProfileSchema, updatePreferencesSchema, updatePrivacySchema, imageUploadSchema } from '../validation/user.validation';
import s3Service from '../services/s3.service';
import profileCompletionService from '../services/profileCompletion.service';
import clerkSyncService from '../services/clerkSync.service';
import lawyerSearchService from '../services/lawyerSearch.service';

const router = Router();

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'));
    }
  }
});

// Rate limiting for image uploads
const imageUploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 uploads per hour
  message: {
    error: 'Too many image uploads. Please try again later.',
    retryAfter: '1 hour'
  }
});

// General rate limiting for profile updates
const profileUpdateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 updates per 15 minutes
  message: {
    error: 'Too many profile updates. Please try again later.',
    retryAfter: '15 minutes'
  }
});

// Test routes (keep for compatibility)
router.get('/test', (req, res) => {
  res.json({
    message: 'User routes working!',
    endpoint: '/api/users/test'
  });
});

router.get('/test-db', async (req, res) => {
  try {
    const userCount = await prisma.user.count();
    res.json({
      message: 'Database connected!',
      userCount: userCount,
      tables: ['users', 'lawyer_profiles', 'appointments', 'messages', 'reviews']
    });
  } catch (error) {
    res.status(500).json({
      message: 'Database error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/users/profile
 * Get complete user profile with all data
 */
router.get('/profile', authenticateClerk, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        lawyerProfile: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate profile completion
    const completion = profileCompletionService.calculateCompletion(user);
    const suggestions = profileCompletionService.getFieldSuggestions(user);
    const completionLevel = profileCompletionService.getCompletionLevel(completion.percentage);
    const meetsMinRequirements = profileCompletionService.meetsMinimumRequirements(user);

    // Update last active timestamp
    await prisma.user.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() }
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        timezone: user.timezone,
        preferredLanguage: user.preferredLanguage,
        lastActiveAt: user.lastActiveAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      lawyerProfile: user.lawyerProfile,
      profileCompletion: {
        score: completion.score,
        percentage: completion.percentage,
        level: completionLevel,
        meetsMinimumRequirements: meetsMinRequirements,
        missingFields: completion.missingFields,
        completedFields: completion.completedFields,
        maxPossibleScore: completion.maxPossibleScore,
        suggestions: suggestions
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/users/profile
 * Update basic user information
 */
router.put('/profile', authenticateClerk, profileUpdateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Validate input
    const { error, value } = updateProfileSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    // Get current user
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user in database
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...value,
        updatedAt: new Date()
      },
      include: {
        lawyerProfile: true
      }
    });

    // Calculate new profile completion score
    const completion = profileCompletionService.calculateCompletion(updatedUser);

    // Note: profileCompletionScore field doesn't exist in minimal schema
    // await prisma.user.update({
    //   where: { id: userId },
    //   data: { profileCompletionScore: completion.score }
    // });

    // Sync changes to Clerk (non-blocking)
    clerkSyncService.syncUserToClerk(currentUser, value).catch(error => {
      console.error('Clerk sync failed for user update:', error);
    });

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        phone: updatedUser.phone,
        bio: updatedUser.bio,
        timezone: updatedUser.timezone,
        preferredLanguage: updatedUser.preferredLanguage,
        updatedAt: updatedUser.updatedAt
      },
      profileCompletion: {
        score: completion.score,
        percentage: completion.percentage,
        level: profileCompletionService.getCompletionLevel(completion.percentage)
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/users/profile/image
 * Upload profile image
 */
router.post('/profile/image', authenticateClerk, imageUploadLimit, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Validate image
    const { error: validationError } = imageUploadSchema.validate({
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    if (validationError) {
      return res.status(400).json({
        error: 'Image validation failed',
        details: validationError.details.map(d => d.message)
      });
    }

    // Additional image validation
    const imageValidation = await s3Service.validateImage(req.file.buffer);
    if (!imageValidation.isValid) {
      return res.status(400).json({ error: imageValidation.error });
    }

    // Get current user to check for existing images
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileImageUrl: true }
    });

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete old images if they exist
    if (currentUser.profileImageUrl) {
      const oldImageUrls = [currentUser.profileImageUrl].filter(Boolean) as string[];
      await s3Service.deleteProfileImages(oldImageUrls).catch(error => {
        console.error('Failed to delete old images:', error);
      });
    }

    // Upload new images
    const imageUrls = await s3Service.uploadProfileImage(req.file.buffer, userId, req.file.originalname);

    // Update user record
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        profileImageUrl: imageUrls.medium,
        updatedAt: new Date()
      },
      include: { lawyerProfile: true }
    });

    // Recalculate profile completion
    const completion = profileCompletionService.calculateCompletion(updatedUser);
    // Note: profileCompletionScore field doesn't exist in minimal schema
    // await prisma.user.update({
    //   where: { id: userId },
    //   data: { profileCompletionScore: completion.score }
    // });

    res.json({
      message: 'Profile image uploaded successfully',
      images: {
        original: imageUrls.original,
        medium: imageUrls.medium,
        thumbnail: imageUrls.thumbnail
      },
      profileCompletion: {
        score: completion.score,
        percentage: completion.percentage
      }
    });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

/**
 * GET /api/users/profile/completion
 * Get profile completion status
 */
router.get('/profile/completion', authenticateClerk, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { lawyerProfile: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const completion = profileCompletionService.calculateCompletion(user);
    const suggestions = profileCompletionService.getFieldSuggestions(user);
    const completionLevel = profileCompletionService.getCompletionLevel(completion.percentage);
    const meetsMinRequirements = profileCompletionService.meetsMinimumRequirements(user);

    // Note: profileCompletionScore field doesn't exist in minimal schema
    // Update completion score in database if different
    // if (user.profileCompletionScore !== completion.score) {
    //   await prisma.user.update({
    //     where: { id: userId },
    //     data: { profileCompletionScore: completion.score }
    //   });
    // }

    res.json({
      completion: {
        score: completion.score,
        percentage: completion.percentage,
        level: completionLevel,
        meetsMinimumRequirements: meetsMinRequirements,
        missingFields: completion.missingFields,
        completedFields: completion.completedFields,
        maxPossibleScore: completion.maxPossibleScore,
        suggestions: suggestions
      }
    });
  } catch (error) {
    console.error('Get completion error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/users/settings/preferences
 * Update notification preferences
 */
router.put('/settings/preferences', authenticateClerk, profileUpdateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Validate input
    const { error, value } = updatePreferencesSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    // Check if user exists
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!userExists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Note: userPreferences model doesn't exist in minimal schema
    // Upsert preferences (create if doesn't exist, update if exists)
    // const preferences = await prisma.userPreferences.upsert({
    //   where: { userId },
    //   update: {
    //     ...value,
    //     updatedAt: new Date()
    //   },
    //   create: {
    //     userId,
    //     ...value
    //   }
    // });

    res.json({
      message: 'Preferences updated successfully (minimal schema - preferences not stored)',
      preferences: value
    });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/users/settings/privacy
 * Update privacy settings
 */
router.put('/settings/privacy', authenticateClerk, profileUpdateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Validate input
    const { error, value } = updatePrivacySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(d => d.message)
      });
    }

    // Check if user exists
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!userExists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Note: userPrivacySettings model doesn't exist in minimal schema
    // Upsert privacy settings
    // const privacySettings = await prisma.userPrivacySettings.upsert({
    //   where: { userId },
    //   update: {
    //     ...value,
    //     updatedAt: new Date()
    //   },
    //   create: {
    //     userId,
    //     ...value
    //   }
    // });

    res.json({
      message: 'Privacy settings updated successfully (minimal schema - settings not stored)',
      privacySettings: value
    });
  } catch (error) {
    console.error('Update privacy settings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/users/lawyers
 * Advanced lawyer search with filtering, ranking, and recommendations
 */
router.get('/lawyers', async (req: Request, res: Response) => {
  try {
    const {
      // Basic pagination
      page = '1',
      limit = '20',

      // Search and filters
      search,
      practiceAreas,
      state,
      city,

      // Experience and pricing
      minExperience,
      maxExperience,
      minRate,
      maxRate,

      // Quality filters
      minRating,
      verified = 'true',

      // Availability
      availableDate,
      availableTime,
      consultationTypes,

      // Other filters
      languagesSpoken,

      // Sorting
      sortBy = 'relevance',
      sortOrder = 'desc'
    } = req.query;

    // Parse query parameters
    const filters: any = {};
    const options: any = {
      page: parseInt(page as string) || 1,
      limit: Math.min(parseInt(limit as string) || 20, 50),
      sortBy: sortBy as string,
      sortOrder: sortOrder as string
    };

    // Build search filters
    if (search) filters.search = search as string;
    if (verified !== undefined) filters.verified = verified === 'true';

    // Practice areas
    if (practiceAreas) {
      const areas = typeof practiceAreas === 'string'
        ? [practiceAreas]
        : practiceAreas as string[];
      filters.practiceAreas = areas;
    }

    // Location
    if (state || city) {
      filters.location = {};
      if (state) filters.location.state = state as string;
      if (city) filters.location.city = city as string;
    }

    // Experience range
    if (minExperience || maxExperience) {
      filters.experience = {};
      if (minExperience) filters.experience.min = parseInt(minExperience as string);
      if (maxExperience) filters.experience.max = parseInt(maxExperience as string);
    }

    // Rate range
    if (minRate || maxRate) {
      filters.hourlyRate = {};
      if (minRate) filters.hourlyRate.min = parseFloat(minRate as string);
      if (maxRate) filters.hourlyRate.max = parseFloat(maxRate as string);
    }

    // Rating filter
    if (minRating) {
      filters.rating = { min: parseFloat(minRating as string) };
    }

    // Consultation types
    if (consultationTypes) {
      const types = typeof consultationTypes === 'string'
        ? [consultationTypes]
        : consultationTypes as string[];
      filters.consultationTypes = types;
    }

    // Languages
    if (languagesSpoken) {
      const languages = typeof languagesSpoken === 'string'
        ? [languagesSpoken]
        : languagesSpoken as string[];
      filters.languagesSpoken = languages;
    }

    // Availability
    if (availableDate || availableTime) {
      filters.availability = {};
      if (availableDate) filters.availability.date = availableDate as string;
      if (availableTime) filters.availability.time = availableTime as string;
    }

    // Execute search
    const searchResults = await lawyerSearchService.searchLawyers(filters, options);

    res.json(searchResults);
  } catch (error) {
    console.error('Lawyer search error:', error);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

/**
 * GET /api/users/lawyers/featured
 * Get featured lawyers (trending, top-rated, new)
 */
router.get('/lawyers/featured', async (req: Request, res: Response) => {
  try {
    const { type = 'top-rated', limit = '10' } = req.query;

    const featuredType = ['trending', 'top-rated', 'new'].includes(type as string)
      ? type as 'trending' | 'top-rated' | 'new'
      : 'top-rated';

    const limitNum = Math.min(parseInt(limit as string) || 10, 20);

    const lawyers = await lawyerSearchService.getFeaturedLawyers(featuredType, limitNum);

    res.json({
      type: featuredType,
      lawyers,
      count: lawyers.length
    });
  } catch (error) {
    console.error('Get featured lawyers error:', error);
    res.status(500).json({ error: 'Failed to get featured lawyers' });
  }
});

/**
 * GET /api/users/lawyers/:lawyerId/similar
 * Get similar lawyers based on practice areas and experience
 */
router.get('/lawyers/:lawyerId/similar', async (req: Request, res: Response) => {
  try {
    const { lawyerId } = req.params;
    const { limit = '5' } = req.query;

    const limitNum = Math.min(parseInt(limit as string) || 5, 10);

    const similarLawyers = await lawyerSearchService.getSimilarLawyers(lawyerId, limitNum);

    res.json({
      lawyerId,
      similarLawyers,
      count: similarLawyers.length
    });
  } catch (error) {
    console.error('Get similar lawyers error:', error);
    res.status(500).json({ error: 'Failed to get similar lawyers' });
  }
});

/**
 * GET /api/users/lawyers/search/suggestions
 * Get search suggestions for filters
 */
router.get('/lawyers/search/suggestions', async (req: Request, res: Response) => {
  try {
    // This endpoint returns filter suggestions without running a full search
    const suggestions = await lawyerSearchService.searchLawyers({}, { limit: 1 });

    res.json({
      practiceAreas: suggestions.filters.suggestions.practiceAreas,
      locations: suggestions.filters.suggestions.locationSuggestions,
      experienceRange: suggestions.filters.suggestions.experienceRange,
      rateRange: suggestions.filters.suggestions.rateRange
    });
  } catch (error) {
    console.error('Get search suggestions error:', error);
    res.status(500).json({ error: 'Failed to get search suggestions' });
  }
});

export default router;
