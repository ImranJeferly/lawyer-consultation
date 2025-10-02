import express from 'express';
import { query, validationResult } from 'express-validator';
import lawyerSearchService from '../services/lawyerSearch.service';

const router = express.Router();

// Validation middleware
const handleValidationErrors = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// GET /api/discovery/features - Get API features and capabilities
router.get('/features', (req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    data: {
      version: '1.0.0',
      features: [
        'lawyer-search',
        'booking-system',
        'document-management',
        'real-time-chat',
        'payment-processing',
        'video-consultation'
      ],
      endpoints: {
        auth: '/api/auth',
        search: '/api/search',
        bookings: '/api/bookings',
        payments: '/api/payments'
      }
    }
  });
});

// GET /api/discovery/explore - Get discovery content (featured, trending, etc.)
router.get('/explore', [
  query('type').optional().isIn(['featured', 'trending', 'new', 'recommended']),
  query('category').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { type = 'featured', category, limit = 20 } = req.query;
    
    // Get featured lawyers using the existing service
    const featuredLawyers = await lawyerSearchService.getFeaturedLawyers(
      type as 'trending' | 'top-rated' | 'new', 
      Number(limit)
    );

    const response = {
      featured: featuredLawyers.slice(0, 5),
      trending: featuredLawyers.slice(5, 10),
      topRated: featuredLawyers.slice(10, 15),
      newLawyers: featuredLawyers.slice(15, 20),
      categories: [
        { name: 'Family Law', count: 145, trending: true },
        { name: 'Personal Injury', count: 132, trending: false },
        { name: 'Criminal Defense', count: 98, trending: true },
        { name: 'Business Law', count: 87, trending: false }
      ]
    };

    res.json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error('Discovery explore error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching discovery content',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/discovery/featured - Get featured lawyers
router.get('/featured', [
  query('category').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { category, limit = 10 } = req.query;
    
    const featuredLawyers = await lawyerSearchService.getFeaturedLawyers('top-rated', Number(limit));

    res.json({
      success: true,
      data: {
        lawyers: featuredLawyers,
        metadata: {
          category: category || 'all',
          total: featuredLawyers.length,
          lastUpdated: new Date()
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching featured lawyers',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/discovery/trending - Get trending lawyers and searches
router.get('/trending', [
  query('timeframe').optional().isIn(['24h', '7d', '30d']),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { timeframe = '7d', limit = 10 } = req.query;
    
    const trendingLawyers = await lawyerSearchService.getFeaturedLawyers('trending', Number(limit));

    const response = {
      lawyers: trendingLawyers,
      searches: [
        { query: 'divorce lawyer', count: 250, change: '+15%' },
        { query: 'personal injury attorney', count: 180, change: '+8%' },
        { query: 'criminal defense', count: 145, change: '+22%' },
        { query: 'business lawyer', count: 120, change: '+5%' }
      ],
      practiceAreas: [
        { name: 'Family Law', searchVolume: 1250, trend: 'up' },
        { name: 'Personal Injury', searchVolume: 980, trend: 'up' },
        { name: 'Criminal Defense', searchVolume: 750, trend: 'stable' },
        { name: 'Business Law', searchVolume: 650, trend: 'down' }
      ],
      timeframe
    };

    res.json({
      success: true,
      data: response
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching trending content',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/discovery/categories - Get practice area categories with stats
router.get('/categories', [
  query('sortBy').optional().isIn(['name', 'count', 'trending']),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { sortBy = 'count', limit = 20 } = req.query;
    
    const categories = [
      { 
        id: 'family-law',
        name: 'Family Law', 
        description: 'Divorce, child custody, adoption, and family matters',
        lawyerCount: 245, 
        averageRating: 4.6,
        averageRate: 275,
        trending: true,
        icon: 'family'
      },
      { 
        id: 'personal-injury',
        name: 'Personal Injury', 
        description: 'Car accidents, slip and fall, medical malpractice',
        lawyerCount: 198, 
        averageRating: 4.5,
        averageRate: 320,
        trending: false,
        icon: 'injury'
      },
      { 
        id: 'criminal-defense',
        name: 'Criminal Defense', 
        description: 'DUI, theft, assault, and criminal charges',
        lawyerCount: 167, 
        averageRating: 4.4,
        averageRate: 295,
        trending: true,
        icon: 'criminal'
      },
      { 
        id: 'business-law',
        name: 'Business Law', 
        description: 'Corporate law, contracts, business formation',
        lawyerCount: 134, 
        averageRating: 4.7,
        averageRate: 385,
        trending: false,
        icon: 'business'
      }
    ];

    // Sort categories based on sortBy parameter
    let sortedCategories = [...categories];
    if (sortBy === 'name') {
      sortedCategories.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'count') {
      sortedCategories.sort((a, b) => b.lawyerCount - a.lawyerCount);
    } else if (sortBy === 'trending') {
      sortedCategories.sort((a, b) => Number(b.trending) - Number(a.trending));
    }

    res.json({
      success: true,
      data: {
        categories: sortedCategories.slice(0, Number(limit)),
        total: categories.length,
        sortBy
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/discovery/recommendations/:userId - Get personalized recommendations
router.get('/recommendations/:userId', [
  query('type').optional().isIn(['similar', 'trending', 'popular']),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { userId } = req.params;
    const { type = 'similar', limit = 10 } = req.query;
    
    // Get recommendations (using featured for now)
    const recommendations = await lawyerSearchService.getFeaturedLawyers('top-rated', Number(limit));

    res.json({
      success: true,
      data: {
        recommendations,
        explanation: `Based on your search history and preferences`,
        type,
        userId
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching personalized recommendations',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/discovery/practice-areas - Get all available practice areas
router.get('/practice-areas', async (req: express.Request, res: express.Response) => {
  try {
    // Return comprehensive list of practice areas
    const practiceAreas = [
      'Corporate Law',
      'Contract Law',
      'Employment Law',
      'Family Law',
      'Criminal Law',
      'Personal Injury',
      'Real Estate Law',
      'Immigration Law',
      'Intellectual Property',
      'Tax Law',
      'Bankruptcy Law',
      'Environmental Law',
      'Medical Malpractice',
      'Civil Rights',
      'Estate Planning',
      'Securities Law',
      'International Law',
      'Entertainment Law',
      'Sports Law',
      'Aviation Law',
      'Maritime Law',
      'Insurance Law',
      'Administrative Law',
      'Constitutional Law',
      'Business Law',
      'Consumer Law',
      'Education Law',
      'Health Care Law',
      'Labor Law',
      'Military Law',
      'Social Security Law',
      'Workers Compensation'
    ];

    res.status(200).json({
      success: true,
      data: practiceAreas,
      count: practiceAreas.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching practice areas',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;