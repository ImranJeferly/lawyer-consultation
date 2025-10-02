import { Router } from 'express';
import { getRateLimitInfo, resetRateLimits } from '../middleware/rateLimiting.middleware';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /api/rate-limits/info
 * Get current rate limit information for the requesting client
 */
router.get('/info', getRateLimitInfo);

/**
 * GET /api/rate-limits/policies
 * Get all available rate limiting policies and their configurations
 */
router.get('/policies', (req, res) => {
  res.json({
    success: true,
    data: {
      policies: {
        general: {
          description: 'General API requests',
          window: '15 minutes',
          limit: 1000,
          applies_to: 'All API endpoints (default)'
        },
        auth: {
          description: 'Authentication requests',
          window: '15 minutes',
          limit: 20,
          applies_to: 'Login, register, password reset endpoints'
        },
        payment: {
          description: 'Payment processing',
          window: '1 hour',
          limit: 10,
          applies_to: 'Payment, refund, payout endpoints'
        },
        upload: {
          description: 'File uploads',
          window: '10 minutes',
          limit: 50,
          applies_to: 'Document upload endpoints'
        },
        search: {
          description: 'Search operations',
          window: '5 minutes',
          limit: 100,
          applies_to: 'Lawyer search, document search endpoints'
        },
        booking: {
          description: 'Booking operations',
          window: '30 minutes',
          limit: 20,
          applies_to: 'Create, update, cancel booking endpoints'
        },
        admin: {
          description: 'Administrative operations',
          window: '1 hour',
          limit: 100,
          applies_to: 'Admin panel endpoints'
        }
      },
      notes: [
        'Rate limits are applied per IP address for unauthenticated requests',
        'Rate limits are applied per user ID for authenticated requests',
        'Health check and monitoring endpoints are exempt from rate limiting',
        'Trusted IP addresses (if configured) are exempt from rate limiting'
      ]
    }
  });
});

/**
 * POST /api/rate-limits/reset
 * Reset rate limits (admin only)
 * Body: { key?: string, policy?: string } - if neither provided, resets all
 */
router.post('/reset', requireAuth, (req, res, next) => {
  // Only allow admins to reset rate limits
  if (req.user?.role !== 'READ') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin role required to reset rate limits'
    });
  }
  
  resetRateLimits(req, res);
});

/**
 * GET /api/rate-limits/status
 * Get overall rate limiting system status
 */
router.get('/status', requireAuth, (req, res) => {
  // Only allow admins to view system status
  if (req.user?.role !== 'READ') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin role required to view rate limit status'
    });
  }

  const { rateLimitStore } = require('../middleware/rateLimiting.middleware');
  
  // Analyze current rate limit usage
  const stats = {
    total_active_limits: rateLimitStore.size,
    policies_in_use: new Set(),
    blocked_clients: 0,
    clients_by_policy: {} as Record<string, number>
  };

  for (const [key, record] of rateLimitStore) {
    const policy = key.split(':')[0];
    stats.policies_in_use.add(policy);
    
    if (!stats.clients_by_policy[policy]) {
      stats.clients_by_policy[policy] = 0;
    }
    stats.clients_by_policy[policy]++;
    
    if (record.blocked) {
      stats.blocked_clients++;
    }
  }

  res.json({
    success: true,
    data: {
      ...stats,
      policies_in_use: Array.from(stats.policies_in_use),
      system_health: stats.blocked_clients / Math.max(stats.total_active_limits, 1) < 0.1 ? 'healthy' : 'warning'
    }
  });
});

export default router;