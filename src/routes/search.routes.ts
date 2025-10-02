import express from 'express';
import { body, query, validationResult } from 'express-validator';
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

// GET /api/search/lawyers - Basic lawyer search
router.get('/lawyers', [
  query('query').optional().isString().trim(),
  query('practiceAreas').optional().isString(),
  query('location').optional().isString(),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('sortBy').optional().isIn(['relevance', 'rating', 'experience', 'hourlyRate', 'distance', 'reviews']),
  query('minRating').optional().isFloat({ min: 0, max: 5 }).toFloat(),
  query('minExperience').optional().isInt({ min: 0 }).toInt(),
  query('maxHourlyRate').optional().isFloat({ min: 0 }).toFloat(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const {
      query: searchQuery,
      practiceAreas,
      location,
      page: rawPage = '1',
      limit: rawLimit = '20',
      sortBy = 'relevance',
      minRating,
      minExperience,
      maxHourlyRate
    } = req.query;

    // Convert to numbers
    const page = parseInt(rawPage as string) || 1;
    const limit = parseInt(rawLimit as string) || 20;

    const filters: any = {};
    
    if (searchQuery) filters.search = searchQuery as string;
    if (practiceAreas) filters.practiceAreas = (practiceAreas as string).split(',');
    if (location) filters.location = { city: location as string };
    if (minRating) filters.rating = { min: Number(minRating) };
    if (minExperience) filters.experience = { min: Number(minExperience) };
    if (maxHourlyRate) filters.hourlyRate = { max: Number(maxHourlyRate) };

    const options = {
      page: page as number,
      limit: limit as number,
      sortBy: sortBy as any
    };

    const results = await lawyerSearchService.searchLawyers(filters, options);

    res.json({
      success: true,
      data: results
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during search',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/search/lawyers/advanced - Advanced search with complex filters
router.post('/lawyers/advanced', [
  body('query').optional().isString().trim(),
  body('filters').optional().isObject(),
  body('options').optional().isObject(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { query: searchQuery, filters = {}, options = {} } = req.body;

    if (searchQuery) filters.search = searchQuery;

    const results = await lawyerSearchService.searchLawyers(filters, options);

    res.json({
      success: true,
      data: results
    });

  } catch (error) {
    console.error('Advanced search error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during advanced search',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/search/suggestions - Get search suggestions
router.get('/suggestions', [
  query('q').isString().trim().isLength({ min: 1 }),
  query('type').optional().isIn(['lawyers', 'practice_areas', 'locations']),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { q: query, type = 'lawyers', limit = 10 } = req.query;

    // Mock suggestions based on query
    const suggestions = {
      items: [
        `${query} lawyer`,
        `${query} attorney`,
        `${query} legal services`
      ].slice(0, limit as number),
      categories: ['lawyers', 'practice_areas', 'locations'],
      trending: ['divorce lawyer', 'personal injury', 'business attorney']
    };

    res.json({
      success: true,
      data: suggestions
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error generating suggestions',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/search/trending - Get trending searches
router.get('/trending', [
  query('timeframe').optional().isIn(['24h', '7d', '30d']),
  query('location').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const { timeframe = '7d', location, limit = 10 } = req.query;

    const trendingData = {
      queries: [
        { query: 'divorce lawyer', count: 150 },
        { query: 'personal injury attorney', count: 120 },
        { query: 'criminal defense', count: 95 },
        { query: 'business lawyer', count: 80 },
        { query: 'immigration attorney', count: 75 }
      ].slice(0, limit as number)
    };

    res.json({
      success: true,
      data: trendingData
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching trending searches',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/search/facets - Get search facets for filtering
router.get('/facets', [
  query('query').optional().isString(),
  handleValidationErrors
], async (req: express.Request, res: express.Response) => {
  try {
    const facets = {
      practiceAreas: [
        { value: 'Family Law', count: 45 },
        { value: 'Personal Injury', count: 32 },
        { value: 'Criminal Defense', count: 28 },
        { value: 'Business Law', count: 25 }
      ],
      locations: [
        { value: 'New York, NY', count: 40 },
        { value: 'Los Angeles, CA', count: 35 },
        { value: 'Chicago, IL', count: 30 },
        { value: 'Houston, TX', count: 25 }
      ],
      experienceRange: [
        { value: '0-5 years', count: 20 },
        { value: '5-10 years', count: 35 },
        { value: '10-15 years', count: 30 },
        { value: '15+ years', count: 25 }
      ],
      priceRange: [
        { value: '$100-200/hr', count: 25 },
        { value: '$200-300/hr', count: 35 },
        { value: '$300-400/hr', count: 20 },
        { value: '$400+/hr', count: 15 }
      ]
    };

    res.json({
      success: true,
      data: facets
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching search facets',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;