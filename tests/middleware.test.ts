import request from 'supertest';
import app from '../src/app';

describe('Middleware Integration Tests', () => {
  describe('Authentication Middleware', () => {
    it('should reject requests without authorization header', async () => {
      const response = await request(app)
        .get('/api/users/profile')
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it('should reject requests with invalid authorization header', async () => {
      const response = await request(app)
        .get('/api/users/profile')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it('should handle malformed authorization headers', async () => {
      const response = await request(app)
        .get('/api/users/profile')
        .set('Authorization', 'InvalidFormat')
        .expect(401);

      expect(response.body).toBeDefined();
    });
  });

  describe('Enhanced Authentication Middleware', () => {
    it('should handle enhanced auth endpoints', async () => {
      // Test endpoints that might use enhanced auth
      const response = await request(app)
        .get('/api/admin/users')
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it('should properly validate admin permissions', async () => {
      const response = await request(app)
        .get('/api/admin/lawyers/pending-verification')
        .expect(401);

      expect(response.body).toBeDefined();
    });
  });

  describe('MFA Middleware', () => {
    it('should handle MFA requirements', async () => {
      // Test MFA-protected endpoints
      const response = await request(app)
        .post('/api/payments/create-intent')
        .send({
          amount: 100,
          currency: 'usd'
        })
        .expect(401);

      expect(response.body).toBeDefined();
    });

    it('should validate MFA tokens properly', async () => {
      const response = await request(app)
        .post('/api/payments/create-intent')
        .set('Authorization', 'Bearer test-token')
        .set('X-MFA-Token', 'invalid-mfa-token')
        .send({
          amount: 100,
          currency: 'usd'
        })
        .expect(401);

      expect(response.body).toBeDefined();
    });
  });

  describe('Validation Middleware', () => {
    it('should validate email format in auth requests', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'invalid-email',
          password: 'test123'
        })
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should validate required fields in user registration', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'test@example.com'
          // Missing required fields
        })
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should validate payment amount format', async () => {
      const response = await request(app)
        .post('/api/payments/create-intent')
        .set('Authorization', 'Bearer test-token')
        .send({
          amount: 'invalid-amount',
          currency: 'usd'
        })
        .expect(400);

      expect(response.body).toBeDefined();
    });

    it('should validate lawyer profile data', async () => {
      const response = await request(app)
        .post('/api/lawyers/profile')
        .set('Authorization', 'Bearer test-token')
        .send({
          licenseNumber: '', // Invalid empty license
          practiceAreas: [],  // Invalid empty areas
          hourlyRate: -100   // Invalid negative rate
        })
        .expect(400);

      expect(response.body).toBeDefined();
    });
  });

  describe('CORS Middleware', () => {
    it('should handle CORS preflight requests', async () => {
      const response = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type,Authorization');

      expect([200, 204]).toContain(response.status);
      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });

    it('should include CORS headers in actual requests', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({
          email: 'test@example.com',
          password: 'test123'
        });

      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });

    it('should handle multiple origins', async () => {
      const origins = [
        'http://localhost:3000',
        'https://app.example.com',
        'https://admin.example.com'
      ];

      for (const origin of origins) {
        const response = await request(app)
          .get('/health')
          .set('Origin', origin);

        expect(response.headers).toHaveProperty('access-control-allow-origin');
      }
    });
  });

  describe('Rate Limiting (if implemented)', () => {
    it('should handle requests within rate limits', async () => {
      // Make several requests to test rate limiting doesn't interfere with normal operation
      const requests = Array.from({ length: 5 }, () =>
        request(app).get('/health').expect(200)
      );

      await Promise.all(requests);
    });
  });

  describe('Content Security and Headers', () => {
    it('should include Helmet security headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(response.headers).toHaveProperty('x-frame-options');
      expect(response.headers).toHaveProperty('x-xss-protection');
    });

    it('should handle Content-Type validation', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'text/plain')
        .send('not-json-data')
        .expect(400);

      expect(response.body).toBeDefined();
    });

    it('should limit request body size', async () => {
      const largePayload = {
        data: 'x'.repeat(10 * 1024 * 1024) // 10MB
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(largePayload);

      // Should either reject large payload or handle gracefully
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('Error Handling Middleware', () => {
    it('should handle JSON parsing errors', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}')
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should provide consistent error format', async () => {
      const response = await request(app)
        .get('/api/non-existent-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('method');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should handle database connection errors gracefully', async () => {
      // This test ensures errors are handled properly, not that they occur
      const response = await request(app)
        .get('/api/lawyers/search')
        .query({ limit: 1 });

      // Should not return 500 for normal operation
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('Request Logging', () => {
    it('should log requests without interfering with responses', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      // Morgan logging shouldn't affect response
      expect(response.body).toHaveProperty('status', 'OK');
    });

    it('should handle requests with various HTTP methods', async () => {
      // Test GET method
      const getResponse = await request(app).get('/health');
      expect(getResponse.status).toBeLessThan(500);
      
      // Test POST method  
      const postResponse = await request(app).post('/health');
      expect(postResponse.status).toBeLessThan(500);
      
      // Test PUT method
      const putResponse = await request(app).put('/health');
      expect(putResponse.status).toBeLessThan(500);
      
      // Test DELETE method
      const deleteResponse = await request(app).delete('/health');
      expect(deleteResponse.status).toBeLessThan(500);
    });
  });

  describe('WebSocket Integration', () => {
    it('should not interfere with HTTP requests', async () => {
      // WebSocket manager should be initialized without affecting HTTP
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('OK');
    });
  });
});