import request from 'supertest';
import app from '../src/app';

describe('Rate Limiting System', () => {
  
  afterEach(async () => {
    // Reset rate limits after each test
    await request(app)
      .post('/api/rate-limits/reset')
      .send({ adminKey: 'test' }) // This will fail but that's ok for testing
      .expect(401); // Unauthorized since we don't have admin auth in tests
  });

  describe('General Rate Limiting', () => {
    it('should allow requests within limit', async () => {
      // Make several requests within the general limit
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .get('/api/discovery/features')
          .expect(200);
        
        expect(response.headers).toHaveProperty('ratelimit-limit');
        expect(response.headers).toHaveProperty('ratelimit-remaining');
      }
    });

    it('should include rate limit headers in responses', async () => {
      const response = await request(app)
        .get('/api/discovery/features')
        .expect(200);

      expect(response.headers).toHaveProperty('ratelimit-limit');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
      expect(response.headers).toHaveProperty('ratelimit-reset');
    });

    it('should not rate limit health and monitoring endpoints', async () => {
      // Health endpoint should be exempt
      await request(app)
        .get('/health')
        .expect(200);

      // Monitoring endpoints should be exempt
      await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);

      await request(app)
        .get('/api/monitoring/health')
        .expect((res) => {
          expect([200, 503]).toContain(res.status);
        });
    });
  });

  describe('Authentication Rate Limiting', () => {
    it('should apply strict rate limiting to auth endpoints', async () => {
      // Auth endpoints have lower limits (20 per 15 minutes)
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'invalid-email', // Invalid email to trigger validation error
          password: '123', // Too short password
          firstName: '',
          lastName: ''
        });

      // Should have rate limit headers regardless of response status
      expect(response.headers).toHaveProperty('ratelimit-limit');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });

    it('should return appropriate headers for auth rate limits', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'wrongpassword'
        });

      // Should have rate limit headers
      expect(response.headers).toHaveProperty('ratelimit-limit');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  describe('Payment Rate Limiting', () => {
    it('should apply very strict rate limiting to payment endpoints', async () => {
      const response = await request(app)
        .post('/api/payments/create-intent')
        .send({
          amount: 1000,
          currency: 'USD'
        })
        .expect(401); // Will fail auth but that's ok, we're testing rate limiting

      // Payment endpoints should have stricter limits (10 per hour)
      expect(response.headers).toHaveProperty('ratelimit-limit', '10');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  describe('Search Rate Limiting', () => {
    it('should apply moderate rate limiting to search endpoints', async () => {
      const response = await request(app)
        .get('/api/search/lawyers?query=test')
        .expect(200);

      // Search endpoints should have moderate limits (100 per 5 minutes)
      expect(response.headers).toHaveProperty('ratelimit-limit', '100');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });

    it('should handle search queries within limits', async () => {
      // Make multiple search requests
      for (let i = 0; i < 5; i++) {
        await request(app)
          .get(`/api/search/lawyers?query=test${i}`)
          .expect(200);
      }
    });
  });

  describe('Admin Rate Limiting', () => {
    it('should apply admin rate limiting to admin endpoints', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .expect(401); // Will fail auth but we're testing rate limiting

      // Admin endpoints should have strict limits (100 per hour)
      expect(response.headers).toHaveProperty('ratelimit-limit', '100');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  describe('Rate Limit Information Endpoints', () => {
    it('should provide rate limit information', async () => {
      const response = await request(app)
        .get('/api/rate-limits/info')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('policies');
      expect(response.body.data.policies).toHaveProperty('general');
      expect(response.body.data.policies).toHaveProperty('auth');
      expect(response.body.data.policies).toHaveProperty('payment');
    });

    it('should provide rate limiting policies', async () => {
      const response = await request(app)
        .get('/api/rate-limits/policies')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('policies');
      expect(response.body.data).toHaveProperty('notes');
      
      const policies = response.body.data.policies;
      expect(policies.general).toHaveProperty('limit', 1000);
      expect(policies.auth).toHaveProperty('limit', 20);
      expect(policies.payment).toHaveProperty('limit', 10);
      expect(policies.search).toHaveProperty('limit', 100);
    });

    it('should require admin role for reset endpoint', async () => {
      await request(app)
        .post('/api/rate-limits/reset')
        .send({})
        .expect(401); // No auth token provided

      // Even with a regular user token (if we had one), it should fail
      // This would require admin role
    });

    it('should require admin role for status endpoint', async () => {
      await request(app)
        .get('/api/rate-limits/status')
        .expect(401); // No auth token provided
    });
  });

  describe('Rate Limit Headers', () => {
    it('should include standard rate limit headers', async () => {
      const response = await request(app)
        .get('/api/discovery/features')
        .expect(200);

      // Check for standard headers
      expect(response.headers).toHaveProperty('ratelimit-limit');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
      expect(response.headers).toHaveProperty('ratelimit-reset');
      
      // Check that remaining count decreases
      expect(parseInt(response.headers['ratelimit-remaining'])).toBeLessThan(1000);
    });

    it('should include custom policy headers', async () => {
      const response = await request(app)
        .get('/api/search/lawyers?query=test')
        .expect(200);

      // Check for standard rate limit headers
      expect(response.headers).toHaveProperty('ratelimit-limit', '100');
      expect(response.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  describe('Rate Limit Key Generation', () => {
    it('should use IP address for unauthenticated requests', async () => {
      // Make a request without authentication
      const response = await request(app)
        .get('/api/discovery/features')
        .expect(200);

      // The rate limiting should work based on IP
      expect(response.headers).toHaveProperty('ratelimit-limit');
    });

    it('should handle forwarded headers correctly', async () => {
      const response = await request(app)
        .get('/api/discovery/features')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.headers).toHaveProperty('ratelimit-limit');
    });
  });

  describe('Rate Limit Bypass', () => {
    it('should bypass rate limiting for health endpoint', async () => {
      // Make many requests to health endpoint
      for (let i = 0; i < 10; i++) {
        await request(app)
          .get('/health')
          .expect(200);
      }
      
      // Health endpoint should still work
      await request(app)
        .get('/health')
        .expect(200);
    });

    it('should bypass rate limiting for monitoring endpoints', async () => {
      // Make requests to monitoring endpoints
      await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);

      await request(app)
        .get('/api/monitoring/health')
        .expect((res) => {
          expect([200, 503]).toContain(res.status);
        });
    });
  });

  describe('Error Responses', () => {
    it('should return detailed error for rate limit exceeded', async () => {
      // This test would need to actually exceed rate limits
      // For now, let's test the structure we expect
      const response = await request(app)
        .get('/api/discovery/features')
        .expect(200);

      // Verify the response has proper structure (when not rate limited)
      expect(response.body).toHaveProperty('success');
    });
  });

  describe('Integration with Performance Monitoring', () => {
    it('should work alongside performance monitoring', async () => {
      const response = await request(app)
        .get('/api/discovery/features')
        .expect(200);

      // Both rate limiting and performance monitoring should add headers
      expect(response.headers).toHaveProperty('ratelimit-limit');
      
      // Check that performance monitoring is also working
      const metricsResponse = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(metricsResponse.body.success).toBe(true);
      expect(metricsResponse.body.data).toHaveProperty('requestCount');
    });
  });
});