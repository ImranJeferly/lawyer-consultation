import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

// Store for rate limiting tracking (for monitoring purposes)
const rateLimitStore = new Map<string, { count: number; resetTime: number; blocked: boolean }>();

// Extend Request interface to include rateLimit property
declare global {
  namespace Express {
    interface Request {
      rateLimit?: {
        limit: number;
        used: number;
        remaining: number;
        resetTime: Date;
      };
    }
  }
}

// Enhanced key generator that considers user authentication
const createKeyGenerator = (prefix: string = 'general') => {
  return (req: Request): string => {
    // If user is authenticated, use user ID
    if (req.user?.id) {
      return `${prefix}:user:${req.user.id}`;
    }
    // Otherwise, use IP address
    const forwarded = req.headers['x-forwarded-for'] as string;
    const ip = forwarded ? forwarded.split(',')[0] : req.connection.remoteAddress;
    return `${prefix}:ip:${ip || 'unknown'}`;
  };
};

// Custom rate limit handler with detailed response
const rateLimitHandler = (req: Request, res: Response) => {
  const retryAfter = Math.round(15 * 60); // 15 minutes in seconds
  
  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter,
    limit: req.rateLimit?.limit || 'unknown',
    remaining: 0,
    resetTime: new Date(Date.now() + (retryAfter * 1000)).toISOString(),
    type: 'RATE_LIMIT_EXCEEDED'
  });
};

// Skip rate limiting for certain conditions
const skipRateLimit = (req: Request): boolean => {
  // Skip rate limiting for health checks
  if (req.path === '/health' || req.path.startsWith('/api/monitoring')) {
    return true;
  }
  
  // Skip for certain IP addresses (e.g., internal monitoring)
  const trustedIPs = process.env.TRUSTED_IPS?.split(',') || [];
  const clientIP = req.headers['x-forwarded-for'] as string || req.connection.remoteAddress;
  if (clientIP && trustedIPs.includes(clientIP)) {
    return true;
  }
  
  return false;
};

// General API rate limiting (more permissive)
export const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP/user to 1000 requests per windowMs
  message: rateLimitHandler,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: createKeyGenerator('general'),
  skip: skipRateLimit,
  // Add custom headers
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '900', // 15 minutes
      'X-RateLimit-Window': '15m',
      'X-RateLimit-Policy': 'general'
    });
    rateLimitHandler(req, res);
  }
});

// Authentication endpoints (stricter due to security concerns)
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 auth requests per 15 minutes
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('auth'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '900',
      'X-RateLimit-Window': '15m',
      'X-RateLimit-Policy': 'auth'
    });
    rateLimitHandler(req, res);
  }
});

// Payment endpoints (very strict)
export const paymentRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each user to 10 payment requests per hour
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('payment'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '3600', // 1 hour
      'X-RateLimit-Window': '1h',
      'X-RateLimit-Policy': 'payment'
    });
    rateLimitHandler(req, res);
  }
});

// File upload endpoints (moderate limits)
export const uploadRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 50, // Limit each user to 50 uploads per 10 minutes
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('upload'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '600', // 10 minutes
      'X-RateLimit-Window': '10m',
      'X-RateLimit-Policy': 'upload'
    });
    rateLimitHandler(req, res);
  }
});

// Search endpoints (moderate limits to prevent abuse)
export const searchRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 100, // Limit each user to 100 searches per 5 minutes
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('search'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '300', // 5 minutes
      'X-RateLimit-Window': '5m',
      'X-RateLimit-Policy': 'search'
    });
    rateLimitHandler(req, res);
  }
});

// Booking endpoints (moderate limits)
export const bookingRateLimit = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 20, // Limit each user to 20 booking operations per 30 minutes
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('booking'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '1800', // 30 minutes
      'X-RateLimit-Window': '30m',
      'X-RateLimit-Policy': 'booking'
    });
    rateLimitHandler(req, res);
  }
});

// Admin endpoints (very strict)
export const adminRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // Limit each admin to 100 admin operations per hour
  message: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('admin'),
  skip: skipRateLimit,
  handler: (req: Request, res: Response) => {
    res.set({
      'Retry-After': '3600', // 1 hour
      'X-RateLimit-Window': '1h',
      'X-RateLimit-Policy': 'admin'
    });
    rateLimitHandler(req, res);
  }
});

// Rate limiting information endpoint
export const getRateLimitInfo = (req: Request, res: Response) => {
  const key = createKeyGenerator('general')(req);
  const record = rateLimitStore.get(key);
  
  res.json({
    success: true,
    data: {
      key: key.replace(/:/g, '_'), // Don't expose the actual key format
      current: record?.count || 0,
      resetTime: record ? new Date(record.resetTime).toISOString() : null,
      policies: {
        general: { window: '15m', limit: 1000 },
        auth: { window: '15m', limit: 20 },
        payment: { window: '1h', limit: 10 },
        upload: { window: '10m', limit: 50 },
        search: { window: '5m', limit: 100 },
        booking: { window: '30m', limit: 20 },
        admin: { window: '1h', limit: 100 }
      }
    }
  });
};

// Reset rate limits (for testing/admin purposes)
export const resetRateLimits = (req: Request, res: Response) => {
  const { key, policy } = req.body;
  
  if (key) {
    // Reset specific key
    rateLimitStore.delete(key);
  } else if (policy) {
    // Reset all keys for a specific policy
    for (const [storeKey] of rateLimitStore) {
      if (storeKey.startsWith(`${policy}:`)) {
        rateLimitStore.delete(storeKey);
      }
    }
  } else {
    // Reset all rate limits
    rateLimitStore.clear();
  }
  
  res.json({
    success: true,
    message: 'Rate limits reset successfully',
    resetType: key ? 'specific_key' : policy ? 'policy' : 'all'
  });
};

// Export the store for testing purposes
export { rateLimitStore };