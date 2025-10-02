import request from 'supertest';
import app from '../src/app';

describe('Performance Monitoring System', () => {
  
  describe('Performance Metrics Collection', () => {
    it('should track request metrics', async () => {
      // Make a few requests to generate metrics
      await request(app).get('/health');
      await request(app).get('/health');
      await request(app).get('/health');
      
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('requestCount');
      expect(response.body.data).toHaveProperty('averageResponseTime');
      expect(response.body.data).toHaveProperty('memoryUsage');
      expect(response.body.data).toHaveProperty('uptime');
      expect(response.body.data).toHaveProperty('healthStatus');
      expect(response.body.data.requestCount).toBeGreaterThan(0);
    });

    it('should track slow requests', async () => {
      // Create a slow endpoint for testing
      const slowResponse = await request(app)
        .get('/api/search/lawyers?query=test&limit=50')
        .expect(200);
      
      const metricsResponse = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(metricsResponse.body.data).toHaveProperty('slowRequests');
      expect(Array.isArray(metricsResponse.body.data.slowRequests)).toBe(true);
    });

    it('should track memory usage', async () => {
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      const memoryUsage = response.body.data.memoryUsage;
      expect(memoryUsage).toHaveProperty('heapTotal');
      expect(memoryUsage).toHaveProperty('heapUsed');
      expect(memoryUsage).toHaveProperty('external');
      expect(memoryUsage).toHaveProperty('rss');
      expect(memoryUsage.heapUsed).toBeGreaterThan(0);
    });
  });

  describe('Health Status Monitoring', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/monitoring/health');
      
      // Health endpoint returns 503 if performance is critical, 200 if healthy/warning
      expect([200, 503]).toContain(response.status);
      expect(response.body.success).toBe(true);
      expect(response.body.health).toHaveProperty('status');
      expect(response.body.health).toHaveProperty('uptime');
      expect(response.body.health).toHaveProperty('memory');
      expect(response.body.health).toHaveProperty('performance');
      expect(['healthy', 'warning', 'critical']).toContain(response.body.health.status);
    });

    it('should provide performance summary in health check', async () => {
      const response = await request(app)
        .get('/api/monitoring/health');
      
      // Health endpoint returns 503 if performance is critical, 200 if healthy/warning
      expect([200, 503]).toContain(response.status);
      const performance = response.body.health.performance;
      expect(performance).toHaveProperty('requestCount');
      expect(performance).toHaveProperty('averageResponseTime');
      expect(performance).toHaveProperty('errorCount');
      expect(performance).toHaveProperty('slowRequestCount');
    });
  });

  describe('Performance Report Generation', () => {
    it('should generate a formatted performance report', async () => {
      const response = await request(app)
        .get('/api/monitoring/report')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('report');
      expect(typeof response.body.report).toBe('string');
      expect(response.body.report).toContain('PERFORMANCE REPORT');
      expect(response.body.report).toContain('Uptime:');
      expect(response.body.report).toContain('Status:');
      expect(response.body.report).toContain('Memory Used:');
    });
  });

  describe('Metrics Reset Functionality', () => {
    it('should reset performance metrics', async () => {
      // First, make some requests to generate metrics
      await request(app).get('/health');
      await request(app).get('/health');
      
      // Get initial metrics
      const initialResponse = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(initialResponse.body.data.requestCount).toBeGreaterThan(0);
      
      // Reset metrics
      await request(app)
        .post('/api/monitoring/reset')
        .expect(200);
      
      // Check that metrics are reset
      const resetResponse = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      // Note: requestCount will be 1 because getting metrics after reset counts as 1 request
      expect(resetResponse.body.data.requestCount).toBe(1);
      expect(resetResponse.body.data.errorCount).toBe(0);
      expect(resetResponse.body.data.slowRequests).toHaveLength(0);
    });
  });

  describe('Error Tracking', () => {
    it('should track 404 errors', async () => {
      // Make a request to a non-existent endpoint
      await request(app)
        .get('/api/non-existent-endpoint')
        .expect(404);
      
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(response.body.data.errorCount).toBeGreaterThan(0);
    });

    it('should track validation errors', async () => {
      // Make an invalid request to trigger validation error
      await request(app)
        .post('/api/auth/register')
        .send({ invalidData: 'test' })
        .expect(400);
      
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(response.body.data.errorCount).toBeGreaterThan(0);
    });
  });

  describe('Database Query Tracking', () => {
    it('should track database queries', async () => {
      // Make requests that involve database queries
      await request(app)
        .get('/api/search/lawyers?query=test')
        .expect(200);
      
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(response.body.data).toHaveProperty('databaseQueries');
      expect(Array.isArray(response.body.data.databaseQueries)).toBe(true);
    });
  });

  describe('Response Time Analysis', () => {
    it('should calculate average response time', async () => {
      // Make multiple requests
      await Promise.all([
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health')
      ]);
      
      const response = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(response.body.data.averageResponseTime).toBeGreaterThan(0);
      expect(typeof response.body.data.averageResponseTime).toBe('number');
    });
  });

  describe('Monitoring Integration', () => {
    it('should work with existing health endpoint', async () => {
      const healthResponse = await request(app)
        .get('/health')
        .expect(200);
      
      expect(healthResponse.body).toHaveProperty('status');
      expect(healthResponse.body.status).toBe('OK');
      
      // Monitoring should track this request
      const metricsResponse = await request(app)
        .get('/api/monitoring/metrics')
        .expect(200);
      
      expect(metricsResponse.body.data.requestCount).toBeGreaterThan(0);
    });
  });
});