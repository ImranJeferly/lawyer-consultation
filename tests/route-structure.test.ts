import request from 'supertest';
import app from '../src/app';

describe('API Route Structure Validation', () => {
  describe('Route Mounting Verification', () => {
    it('should have health check endpoint working', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'OK');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });

    it('should have auth routes mounted', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({});

      // Should not return 404 (route exists), but may return 400/401 (validation/auth error)
      expect(response.status).not.toBe(404);
    });

    it('should have MFA routes mounted', async () => {
      const response = await request(app)
        .post('/api/mfa/setup')
        .send({});

      // Should not return 404 (route exists)
      expect(response.status).not.toBe(404);
      expect([401, 400, 200]).toContain(response.status);
    });

    it('should have user routes mounted', async () => {
      const response = await request(app)
        .get('/api/users/profile');

      // Should not return 404 (route exists), but may require auth
      expect(response.status).not.toBe(404);
      expect([401, 200]).toContain(response.status);
    });

    it('should have search routes mounted', async () => {
      const response = await request(app)
        .get('/api/search/lawyers')
        .query({ query: 'test' });

      // Should not return 404 (route exists)
      expect(response.status).not.toBe(404);
    });

    it('should have discovery routes mounted', async () => {
      const response = await request(app)
        .get('/api/discovery/practice-areas');

      // Should not return 404 (route exists)  
      expect(response.status).not.toBe(404);
    });

    it('should have communications routes mounted', async () => {
      const response = await request(app)
        .post('/api/communications/start-conversation')
        .send({});

      // Should not return 404 (route exists)
      expect(response.status).not.toBe(404);
    });
  });

  describe('Error Handling Structure', () => {
    it('should return 404 for truly non-existent routes', async () => {
      const response = await request(app)
        .get('/api/definitely-does-not-exist')
        .expect(404);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('method');
    });

    it('should have consistent 404 error format', async () => {
      const response = await request(app)
        .post('/api/non-existent-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('message', 'Route not found');
      expect(response.body).toHaveProperty('path', '/api/non-existent-endpoint');
      expect(response.body).toHaveProperty('method', 'POST');
      expect(response.body).toHaveProperty('error', 'Not Found');
    });
  });

  describe('Middleware Integration', () => {
    it('should include CORS headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });

    it('should include security headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers).toHaveProperty('x-frame-options');
    });

    it('should handle JSON content type', async () => {
      const response = await request(app)
        .post('/api/mfa/setup')
        .set('Content-Type', 'application/json')
        .send('{}');

      // Should parse JSON and not return format error
      expect(response.status).not.toBe(415); // Unsupported Media Type
    });

    it('should log requests (Morgan middleware)', async () => {
      // Test that Morgan doesn't interfere with normal operation
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('OK');
    });
  });

  describe('Body Parser Configuration', () => {
    it('should accept JSON payloads up to limit', async () => {
      const smallPayload = { test: 'data' };
      
      const response = await request(app)
        .post('/api/mfa/setup')
        .send(smallPayload);

      // Should not reject due to body parsing
      expect([200, 400, 401]).toContain(response.status);
    });

    it('should handle URL encoded data', async () => {
      const response = await request(app)
        .post('/api/auth/webhook')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('key=value');

      // Should parse URL encoded data
      expect(response.status).not.toBe(415);
    });
  });

  describe('Route Parameters and Query Strings', () => {
    it('should handle route parameters', async () => {
      const response = await request(app)
        .get('/api/mfa/status/test-user-id');

      // Should handle route parameter (not 404 for route structure)
      expect(response.status).not.toBe(404);
    });

    it('should handle query parameters', async () => {
      const response = await request(app)
        .get('/api/search/lawyers')
        .query({
          query: 'test',
          limit: 10,
          offset: 0
        });

      // Should handle query parameters
      expect(response.status).not.toBe(404);
    });
  });

  describe('HTTP Methods Support', () => {
    it('should support GET requests', async () => {
      await request(app)
        .get('/health')
        .expect(200);
    });

    it('should support POST requests', async () => {
      const response = await request(app)
        .post('/api/mfa/setup')
        .send({});

      // Should handle POST (not method not allowed)
      expect(response.status).not.toBe(405);
    });

    it('should handle OPTIONS for CORS preflight', async () => {
      const response = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST');

      expect([200, 204]).toContain(response.status);
    });
  });

  describe('WebSocket Integration', () => {
    it('should not interfere with HTTP endpoints', async () => {
      // WebSocket manager should be initialized without affecting HTTP routes
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('OK');
    });
  });
});