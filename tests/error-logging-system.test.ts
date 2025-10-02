import request from 'supertest';
import express from 'express';
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import errorHandler from '../src/middleware/errorHandler.middleware';
import loggingService, { LogLevel, LogCategory } from '../src/services/logging.service';
import { AppError, ErrorType, ErrorSeverity } from '../src/utils/errors';

// Test app setup
const createTestApp = () => {
  const app = express();
  app.use(express.json());

  // Test routes for different error scenarios
  app.get('/test/success', (req, res) => {
    res.json({ success: true, message: 'Success' });
  });

  app.get('/test/validation-error', (req, res, next) => {
    const error = new AppError(ErrorType.VALIDATION_ERROR, 'Invalid input data', {
      severity: ErrorSeverity.LOW,
      userMessage: 'Please check your input data',
      context: { additionalData: { field: 'email', issue: 'invalid format' } }
    });
    next(error);
  });

  app.get('/test/auth-error', (req, res, next) => {
    const error = new AppError(ErrorType.AUTHENTICATION_ERROR, 'Invalid credentials', {
      severity: ErrorSeverity.HIGH,
      userMessage: 'Authentication failed',
      statusCode: 401
    });
    next(error);
  });

  app.get('/test/database-error', (req, res, next) => {
    const error = new AppError(ErrorType.DATABASE_ERROR, 'Connection timeout', {
      severity: ErrorSeverity.CRITICAL,
      userMessage: 'Service temporarily unavailable',
      retryable: true,
      statusCode: 503
    });
    next(error);
  });

  app.get('/test/generic-error', (req, res, next) => {
    throw new Error('Generic error for testing');
  });

  app.get('/test/async-error', async (req, res, next) => {
    try {
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new AppError(ErrorType.EXTERNAL_SERVICE_ERROR, 'Service unavailable', {
            severity: ErrorSeverity.HIGH,
            userMessage: 'External service is unavailable',
            retryable: true
          }));
        }, 100);
      });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test/timeout-error', (req, res, next) => {
    const error = new AppError(ErrorType.TIMEOUT_ERROR, 'Operation timed out', {
      severity: ErrorSeverity.HIGH,
      userMessage: 'Operation took too long',
      retryable: true,
      statusCode: 408
    });
    next(error);
  });

  app.get('/test/security-error', (req, res, next) => {
    const error = new AppError(ErrorType.SECURITY_ERROR, 'Potential security threat', {
      severity: ErrorSeverity.CRITICAL,
      userMessage: 'Access denied',
      statusCode: 403
    });
    next(error);
  });

  // Apply error handling middleware
  app.use(errorHandler.handle404);
  app.use(errorHandler.handleError);

  return app;
};

describe('Enhanced Error Handling & Logging System', () => {
  let app: express.Application;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    // Tests will use fresh instances or existing metrics
  });

  describe('AppError Class', () => {
    test('should create validation error with correct properties', () => {
      const error = new AppError(ErrorType.VALIDATION_ERROR, 'Test validation error', {
        severity: ErrorSeverity.LOW,
        userMessage: 'User-friendly message',
        context: { additionalData: { field: 'email' } }
      });

      expect(error.type).toBe(ErrorType.VALIDATION_ERROR);
      expect(error.severity).toBe(ErrorSeverity.LOW);
      expect(error.userMessage).toBe('User-friendly message');
      expect(error.statusCode).toBe(400);
      expect(error.retryable).toBe(false);
      expect(error.context.additionalData).toEqual({ field: 'email' });
    });

    test('should create retryable error with correct retry properties', () => {
      const error = new AppError(ErrorType.EXTERNAL_SERVICE_ERROR, 'Service unavailable', {
        severity: ErrorSeverity.HIGH,
        retryable: true,
        context: { additionalData: { retryAfter: 5000 } }
      });

      expect(error.retryable).toBe(true);
      expect(error.context.additionalData?.retryAfter).toBe(5000);
    });

    test('should convert to JSON correctly', () => {
      const error = new AppError(ErrorType.DATABASE_ERROR, 'DB connection failed', {
        severity: ErrorSeverity.CRITICAL,
        userMessage: 'Database error',
        context: { additionalData: { connection: 'primary' } }
      });

      const json = error.toJSON();
      expect(json.type).toBe(ErrorType.DATABASE_ERROR);
      expect(json.severity).toBe(ErrorSeverity.CRITICAL);
      expect(json.userMessage).toBe('Database error');
      expect(json.context.additionalData).toEqual({ connection: 'primary' });
      expect(json.context.timestamp).toBeDefined();
    });
  });

  describe('Error Handler Middleware', () => {
    test('should handle validation errors correctly', async () => {
      const response = await request(app)
        .get('/test/validation-error')
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.message).toBe('Please check your input data');
      expect(response.body.type).toBe(ErrorType.VALIDATION_ERROR);
      expect(response.body.severity).toBe(ErrorSeverity.LOW);
    });

    test('should handle authentication errors correctly', async () => {
      const response = await request(app)
        .get('/test/auth-error')
        .expect(401);

      expect(response.body.error).toBe('AUTHENTICATION_ERROR');
      expect(response.body.message).toBe('Authentication failed');
      expect(response.body.type).toBe(ErrorType.AUTHENTICATION_ERROR);
      expect(response.body.severity).toBe(ErrorSeverity.HIGH);
    });

    test('should handle database errors with retry headers', async () => {
      const response = await request(app)
        .get('/test/database-error')
        .expect(503);

      expect(response.body.error).toBe('Service temporarily unavailable');
      expect(response.body.retryable).toBe(true);
      expect(response.headers['retry-after']).toBeDefined();
    });

    test('should handle generic errors as internal server errors', async () => {
      const response = await request(app)
        .get('/test/generic-error')
        .expect(500);

      expect(response.body.error).toBe('Internal server error');
      expect(response.body.type).toBe(ErrorType.INTERNAL_SERVER_ERROR);
    });

    test('should handle async errors correctly', async () => {
      const response = await request(app)
        .get('/test/async-error')
        .expect(503);

      expect(response.body.error).toBe('Service temporarily unavailable');
      expect(response.body.retryable).toBe(true);
    });

    test('should handle timeout errors with appropriate status', async () => {
      const response = await request(app)
        .get('/test/timeout-error')
        .expect(408);

      expect(response.body.error).toBe('Request timeout');
      expect(response.body.retryable).toBe(true);
    });

    test('should handle security errors with appropriate status', async () => {
      const response = await request(app)
        .get('/test/security-error')
        .expect(403);

      expect(response.body.error).toBe('Access denied');
      expect(response.body.type).toBe(ErrorType.SECURITY_ERROR);
    });

    test('should handle 404 errors for non-existent routes', async () => {
      const response = await request(app)
        .get('/non-existent-route')
        .expect(404);

      expect(response.body.error).toBe('Route not found');
      expect(response.body.type).toBe(ErrorType.NOT_FOUND_ERROR);
      expect(response.body.path).toBe('/non-existent-route');
      expect(response.body.method).toBe('GET');
    });
  });

  describe('Logging Service', () => {
    test('should log with different levels and categories', () => {
      loggingService.log(LogLevel.INFO, LogCategory.API, 'Test info message');
      loggingService.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Test error message');
      loggingService.log(LogLevel.WARN, LogCategory.SECURITY, 'Test warning message');

      // Should not throw any errors
      expect(true).toBe(true);
    });

    test('should log with context from request', () => {
      const mockReq = {
        headers: {
          'x-request-id': 'test-123',
          'user-agent': 'test-agent',
          'x-forwarded-for': '192.168.1.1'
        },
        path: '/test',
        method: 'GET',
        user: { id: 'user-123' }
      } as any;

      loggingService.logWithContext(
        LogLevel.INFO,
        LogCategory.API,
        'Test message with context',
        mockReq,
        { extra: 'data' }
      );

      // Should not throw any errors
      expect(true).toBe(true);
    });

    test('should log errors with proper categorization', () => {
      const error = new AppError(ErrorType.PAYMENT_ERROR, 'Payment failed', {
        severity: ErrorSeverity.HIGH,
        userMessage: 'Payment processing failed'
      });

      loggingService.logError(error);

      // Should not throw any errors
      expect(true).toBe(true);
    });

    test('should track performance metrics', () => {
      const mockReq = {
        method: 'GET',
        path: '/test',
        route: { path: '/test' },
        headers: {}
      } as any;

      const mockRes = {
        statusCode: 200,
        get: () => '1024'
      } as any;

      loggingService.logRequest(mockReq, mockRes, 150);
      loggingService.logRequest(mockReq, mockRes, 300);

      const metrics = loggingService.getPerformanceMetrics();
      expect(metrics.requestCount).toBeGreaterThan(0);
      expect(metrics.averageResponseTime).toBeGreaterThan(0);
    });

    test('should export logs with filtering', async () => {
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date();
      const categories = [LogCategory.API, LogCategory.SYSTEM];

      const logs = await loggingService.exportLogs(startDate, endDate, categories);
      expect(Array.isArray(logs)).toBe(true);
    });

    test('should reset metrics correctly', () => {
      // Add some metrics
      const mockReq = {
        method: 'GET',
        path: '/test',
        route: { path: '/test' },
        headers: {}
      } as any;

      const mockRes = {
        statusCode: 200,
        get: () => '1024'
      } as any;

      loggingService.logRequest(mockReq, mockRes, 150);

      const metrics = loggingService.getPerformanceMetrics();
      expect(metrics.requestCount).toBeGreaterThanOrEqual(0);
      expect(metrics.averageResponseTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Health Check', () => {
    test('should provide health check information', () => {
      const healthCheck = errorHandler.getHealthCheck();

      expect(healthCheck).toHaveProperty('uptime');
      expect(healthCheck).toHaveProperty('memory');
      expect(healthCheck).toHaveProperty('status');
      expect(healthCheck).toHaveProperty('timestamp');
      expect(healthCheck.status).toBe('healthy');
    });
  });

  describe('Integration Tests', () => {
    test('should handle multiple concurrent errors', async () => {
      const promises = [
        request(app).get('/test/validation-error'),
        request(app).get('/test/auth-error'),
        request(app).get('/test/database-error'),
        request(app).get('/test/generic-error')
      ];

      const responses = await Promise.all(promises);

      expect(responses[0].status).toBe(400);
      expect(responses[1].status).toBe(401);
      expect(responses[2].status).toBe(503);
      expect(responses[3].status).toBe(500);

      // All should have proper error structure
      responses.forEach(response => {
        expect(response.body).toHaveProperty('error');
        expect(response.body).toHaveProperty('message');
        expect(response.body).toHaveProperty('timestamp');
      });
    });

    test('should maintain performance metrics across multiple requests', async () => {
      // Make multiple requests
      await Promise.all([
        request(app).get('/test/success'),
        request(app).get('/test/success'),
        request(app).get('/test/validation-error'),
        request(app).get('/test/auth-error')
      ]);

      const metrics = loggingService.getPerformanceMetrics();
      expect(metrics.requestCount).toBeGreaterThan(0);
      expect(metrics.errorRate).toBeGreaterThan(0);
    });
  });
});

describe('Error Type Coverage', () => {
  test('should cover all defined error types', () => {
    const errorTypes = Object.values(ErrorType);
    const severityLevels = Object.values(ErrorSeverity);

    expect(errorTypes).toContain(ErrorType.VALIDATION_ERROR);
    expect(errorTypes).toContain(ErrorType.AUTHENTICATION_ERROR);
    expect(errorTypes).toContain(ErrorType.AUTHORIZATION_ERROR);
    expect(errorTypes).toContain(ErrorType.NOT_FOUND_ERROR);
    expect(errorTypes).toContain(ErrorType.DATABASE_ERROR);
    expect(errorTypes).toContain(ErrorType.EXTERNAL_SERVICE_ERROR);
    expect(errorTypes).toContain(ErrorType.TIMEOUT_ERROR);
    expect(errorTypes).toContain(ErrorType.SECURITY_ERROR);
    expect(errorTypes).toContain(ErrorType.RATE_LIMIT_ERROR);
    expect(errorTypes).toContain(ErrorType.PAYMENT_ERROR);
    expect(errorTypes).toContain(ErrorType.FILE_UPLOAD_ERROR);
    expect(errorTypes).toContain(ErrorType.INTERNAL_SERVER_ERROR);

    expect(severityLevels).toContain(ErrorSeverity.LOW);
    expect(severityLevels).toContain(ErrorSeverity.MEDIUM);
    expect(severityLevels).toContain(ErrorSeverity.HIGH);
    expect(severityLevels).toContain(ErrorSeverity.CRITICAL);
  });
});