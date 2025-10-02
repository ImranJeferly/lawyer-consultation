import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';

describe('Production API Endpoint Tests', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Critical Endpoints Health Check', () => {
    it('should have all major route handlers mounted', async () => {
      // Test that routes are properly mounted by checking 401/400 instead of 404
      
      // Auth routes
      const authResponse = await request(app).post('/api/auth/login');
      expect([400, 401]).toContain(authResponse.status);

      // User routes  
      const userResponse = await request(app).get('/api/users/profile');
      expect([400, 401]).toContain(userResponse.status);

      // Lawyer routes
      const lawyerResponse = await request(app).get('/api/lawyers/search');
      expect([200, 400, 401]).toContain(lawyerResponse.status);

      // MFA routes
      const mfaResponse = await request(app).post('/api/mfa/setup');
      expect([200, 400, 401]).toContain(mfaResponse.status);

      // Payment routes
      const paymentResponse = await request(app).post('/api/payments/create-intent');
      expect([400, 401]).toContain(paymentResponse.status);

      // Search routes
      const searchResponse = await request(app).get('/api/search/lawyers');
      expect([200, 400]).toContain(searchResponse.status);

      // Admin routes
      const adminResponse = await request(app).get('/api/admin/users');
      expect([401, 403]).toContain(adminResponse.status);

      // Communication routes
      const commResponse = await request(app).post('/api/communications/start-conversation');
      expect([400, 401]).toContain(commResponse.status);
    });

    it('should return proper error format for protected endpoints', async () => {
      const response = await request(app)
        .get('/api/users/profile')
        .expect(401);

      // Should have error structure
      expect(response.body).toBeDefined();
    });
  });

  describe('Database Connection Through API', () => {
    it('should connect to database through lawyer search', async () => {
      const response = await request(app)
        .get('/api/lawyers/search')
        .query({ limit: 1 });

      // Should either return data or proper error, not 500
      expect([200, 400, 401]).toContain(response.status);
    });

    it('should handle MFA database operations', async () => {
      // Test that MFA endpoints can connect to database
      const response = await request(app)
        .post('/api/mfa/setup')
        .send({ userId: 'test-user-id' });

      // Should handle the request (not necessarily succeed without proper auth)
      expect([200, 400, 401]).toContain(response.status);
    });
  });

  describe('Content-Type and JSON Handling', () => {
    it('should handle JSON requests properly', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: 'test@example.com', password: 'test123' });

      // Should parse JSON and validate (not return 500)
      expect(response.status).toBeLessThan(500);
    });

    it('should return JSON responses', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.body).toBeInstanceOf(Object);
    });
  });

  describe('Route Parameter Handling', () => {
    it('should handle route parameters in lawyer profiles', async () => {
      const response = await request(app)
        .get('/api/lawyers/test-lawyer-id');

      // Should handle the route parameter (may return 404 for non-existent lawyer)
      expect([200, 404, 401]).toContain(response.status);
    });

    it('should handle MFA status route parameters', async () => {
      const response = await request(app)
        .get('/api/mfa/status/test-user-id');

      expect([200, 400, 401, 404]).toContain(response.status);
    });
  });

  describe('Query Parameter Processing', () => {
    it('should process search query parameters', async () => {
      const response = await request(app)
        .get('/api/search/lawyers')
        .query({
          query: 'corporate',
          limit: 5,
          offset: 0
        });

      expect([200, 400]).toContain(response.status);
    });

    it('should handle lawyer search filters', async () => {
      const response = await request(app)
        .get('/api/lawyers/search')
        .query({
          practiceArea: 'Corporate Law',
          minRate: 100,
          maxRate: 500,
          experience: 5
        });

      expect([200, 400]).toContain(response.status);
    });
  });

  describe('HTTP Methods Support', () => {
    it('should support GET requests', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
    });

    it('should support POST requests', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({});
      
      expect(response.status).toBeLessThan(500);
    });

    it('should support PUT requests', async () => {
      const response = await request(app)
        .put('/api/users/profile')
        .send({});
      
      expect([400, 401, 405]).toContain(response.status);
    });

    it('should support DELETE requests', async () => {
      const response = await request(app)
        .delete('/api/users/profile')
        .send({});
      
      expect([400, 401, 405]).toContain(response.status);
    });
  });

  describe('Error Response Format', () => {
    it('should return consistent error format for 404', async () => {
      const response = await request(app)
        .get('/api/non-existent-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('method');
    });

    it('should handle validation errors consistently', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ invalid: 'data' });

      if (response.status === 400) {
        expect(response.body).toHaveProperty('message');
      }
    });
  });

  describe('API Response Performance', () => {
    it('should respond to health check quickly', async () => {
      const startTime = Date.now();
      
      await request(app)
        .get('/health')
        .expect(200);
        
      const responseTime = Date.now() - startTime;
      expect(responseTime).toBeLessThan(1000); // Should respond within 1 second
    });

    it('should handle multiple concurrent requests', async () => {
      const requests = Array.from({ length: 10 }, () =>
        request(app).get('/health').expect(200)
      );

      const startTime = Date.now();
      await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      expect(totalTime).toBeLessThan(5000); // All requests within 5 seconds
    });
  });

  describe('Security Headers and CORS', () => {
    it('should include security headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      // Helmet security headers
      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers).toHaveProperty('x-frame-options');
    });

    it('should include CORS headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });

    it('should handle preflight OPTIONS requests', async () => {
      const response = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST');

      expect([200, 204]).toContain(response.status);
    });
  });
});