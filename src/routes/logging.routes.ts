import { Router, Request, Response } from 'express';
import loggingService, { LogLevel, LogCategory, PerformanceMetrics } from '../services/logging.service';
import errorHandler from '../middleware/errorHandler.middleware';
import { AppError, ErrorType, ErrorSeverity } from '../utils/errors';

const router = Router();

// Get system health including error metrics
router.get('/health', async (req: Request, res: Response) => {
  try {
    const healthCheck = errorHandler.getHealthCheck();
    
    res.json({
      success: true,
      data: healthCheck
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get health status',
      message: (error as Error).message
    });
  }
});

// Get performance metrics
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = loggingService.getPerformanceMetrics();
    
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get performance metrics',
      message: (error as Error).message
    });
  }
});

// Get detailed system status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const metrics = loggingService.getPerformanceMetrics();
    const healthCheck = errorHandler.getHealthCheck();
    
    // Determine overall system status
    let status = 'healthy';
    const issues: string[] = [];
    
    if (metrics.errorRate > 10) {
      status = 'warning';
      issues.push(`High error rate: ${metrics.errorRate}%`);
    }
    
    if (metrics.averageResponseTime > 5000) {
      status = 'warning';
      issues.push(`Slow response time: ${metrics.averageResponseTime}ms`);
    }
    
    if (metrics.memoryUsage.heapUsed / metrics.memoryUsage.heapTotal > 0.9) {
      status = 'critical';
      issues.push('High memory usage');
    }
    
    if (metrics.slowQueries > 10) {
      status = 'warning';
      issues.push(`Multiple slow queries: ${metrics.slowQueries}`);
    }
    
    res.json({
      success: true,
      data: {
        status,
        issues,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        metrics,
        health: healthCheck
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system status',
      message: (error as Error).message
    });
  }
});

// Manual log entry (for testing/debugging)
router.post('/log', async (req: Request, res: Response) => {
  try {
    const { level, category, message, metadata } = req.body;
    
    if (!level || !category || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Level, category, and message are required'
      });
    }
    
    if (!Object.values(LogLevel).includes(level)) {
      return res.status(400).json({
        error: 'Invalid log level',
        message: `Log level must be one of: ${Object.values(LogLevel).join(', ')}`
      });
    }
    
    if (!Object.values(LogCategory).includes(category)) {
      return res.status(400).json({
        error: 'Invalid log category',
        message: `Log category must be one of: ${Object.values(LogCategory).join(', ')}`
      });
    }
    
    loggingService.logWithContext(level, category, message, req, metadata);
    
    res.json({
      success: true,
      message: 'Log entry created'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to create log entry',
      message: (error as Error).message
    });
  }
});

// Test error handling (for development/testing)
router.post('/test-errors', async (req: Request, res: Response, next) => {
  try {
    const { type, message, severity } = req.body;
    
    if (!type) {
      return res.status(400).json({
        error: 'Error type required',
        message: 'Please specify an error type to test'
      });
    }
    
    // Create test error based on type
    let testError: AppError;
    
    switch (type) {
      case 'validation':
        testError = new AppError(ErrorType.VALIDATION_ERROR, message || 'Test validation error', {
          severity: severity || ErrorSeverity.LOW,
          userMessage: 'This is a test validation error'
        });
        break;
        
      case 'authentication':
        testError = new AppError(ErrorType.AUTHENTICATION_ERROR, message || 'Test authentication error', {
          severity: severity || ErrorSeverity.HIGH,
          userMessage: 'Authentication failed for testing'
        });
        break;
        
      case 'authorization':
        testError = new AppError(ErrorType.AUTHORIZATION_ERROR, message || 'Test authorization error', {
          severity: severity || ErrorSeverity.HIGH,
          userMessage: 'Access denied for testing'
        });
        break;
        
      case 'not_found':
        testError = new AppError(ErrorType.NOT_FOUND_ERROR, message || 'Test resource not found', {
          severity: severity || ErrorSeverity.LOW,
          userMessage: 'Test resource not found'
        });
        break;
        
      case 'database':
        testError = new AppError(ErrorType.DATABASE_ERROR, message || 'Test database error', {
          severity: severity || ErrorSeverity.CRITICAL,
          userMessage: 'Database error occurred during testing',
          retryable: true
        });
        break;
        
      case 'external_service':
        testError = new AppError(ErrorType.EXTERNAL_SERVICE_ERROR, message || 'Test external service error', {
          severity: severity || ErrorSeverity.HIGH,
          userMessage: 'External service error during testing',
          retryable: true
        });
        break;
        
      case 'timeout':
        testError = new AppError(ErrorType.TIMEOUT_ERROR, message || 'Test timeout error', {
          severity: severity || ErrorSeverity.HIGH,
          userMessage: 'Operation timed out during testing',
          retryable: true
        });
        break;
        
      case 'security':
        testError = new AppError(ErrorType.SECURITY_ERROR, message || 'Test security error', {
          severity: severity || ErrorSeverity.CRITICAL,
          userMessage: 'Security violation detected during testing'
        });
        break;
        
      default:
        testError = new AppError(ErrorType.INTERNAL_SERVER_ERROR, message || 'Test internal error', {
          severity: severity || ErrorSeverity.MEDIUM,
          userMessage: 'Internal server error during testing'
        });
    }
    
    // Throw the error to test error handling
    throw testError;
    
  } catch (error) {
    next(error);
  }
});

// Test async error handling
router.post('/test-async-errors', async (req: Request, res: Response, next) => {
  try {
    const { delay = 1000 } = req.body;
    
    // Simulate async operation that fails
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new AppError(ErrorType.EXTERNAL_SERVICE_ERROR, 'Async operation failed', {
          severity: ErrorSeverity.HIGH,
          userMessage: 'Async test operation failed',
          retryable: true
        }));
      }, delay);
    });
    
    res.json({ success: true, message: 'This should not be reached' });
  } catch (error) {
    next(error);
  }
});

// Get error statistics
router.get('/error-stats', async (req: Request, res: Response) => {
  try {
    const metrics = loggingService.getPerformanceMetrics();
    
    // Additional error statistics could be gathered here
    const stats = {
      totalRequests: metrics.requestCount,
      errorRate: metrics.errorRate,
      averageResponseTime: metrics.averageResponseTime,
      slowQueries: metrics.slowQueries,
      uptime: metrics.uptime,
      memoryUsage: metrics.memoryUsage,
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get error statistics',
      message: (error as Error).message
    });
  }
});

// Export logs (simplified version)
router.get('/export-logs', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, categories } = req.query;
    
    // Validate dates
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format',
        message: 'Please provide valid ISO date strings'
      });
    }
    
    // Parse categories
    let logCategories: LogCategory[] | undefined;
    if (categories) {
      const categoryArray = (categories as string).split(',');
      logCategories = categoryArray.filter(cat => Object.values(LogCategory).includes(cat as LogCategory)) as LogCategory[];
    }
    
    // Export logs (this would typically query a log storage system)
    const logs = await loggingService.exportLogs(start, end, logCategories);
    
    res.json({
      success: true,
      data: {
        logs,
        period: {
          start: start.toISOString(),
          end: end.toISOString()
        },
        categories: logCategories,
        count: logs.length
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to export logs',
      message: (error as Error).message
    });
  }
});

// Log levels and categories info
router.get('/info', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: {
        logLevels: Object.values(LogLevel),
        logCategories: Object.values(LogCategory),
        errorTypes: Object.values(ErrorType),
        errorSeverities: Object.values(ErrorSeverity),
        features: [
          'Structured logging with Winston',
          'Performance metrics tracking',
          'Error categorization and severity levels',
          'Security event logging',
          'Request/response logging',
          'Async error handling',
          'Retry logic for retryable errors',
          'Memory and uptime monitoring'
        ]
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get logging info',
      message: (error as Error).message
    });
  }
});

export default router;