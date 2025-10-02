// Enhanced error handling middleware
import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorType, ErrorSeverity, createErrorContext } from '../utils/errors';
import loggingService from '../services/logging.service';
import securityService from '../services/security.service';
import { SecurityEventType, SecurityRiskLevel } from '../config/security.config';

export interface ErrorHandlerOptions {
  includeStackTrace?: boolean;
  logErrors?: boolean;
  logSecurityEvents?: boolean;
  enableRetryHeaders?: boolean;
}

class ErrorHandlingMiddleware {
  private options: ErrorHandlerOptions;

  constructor(options: ErrorHandlerOptions = {}) {
    this.options = {
      includeStackTrace: process.env.NODE_ENV === 'development',
      logErrors: true,
      logSecurityEvents: true,
      enableRetryHeaders: true,
      ...options
    };
  }

  // Main error handling middleware
  public handleError = (error: Error, req: Request, res: Response, next: NextFunction): void => {
    // Set request ID if not present
    if (!req.headers['x-request-id']) {
      req.headers['x-request-id'] = Math.random().toString(36).substring(2);
    }

    let appError: AppError;

    // Convert generic errors to AppError
    if (error instanceof AppError) {
      appError = error;
    } else {
      appError = this.convertToAppError(error, req);
    }

    // Log the error
    if (this.options.logErrors) {
      loggingService.logError(appError, req, {
        originalError: error.message,
        stack: error.stack
      });
    }

    // Log security events for security-related errors
    if (this.options.logSecurityEvents && this.isSecurityError(appError)) {
      this.logSecurityEvent(appError, req);
    }

    // Set security headers for error responses
    this.setSecurityHeaders(res, appError);

    // Set retry headers for retryable errors
    if (this.options.enableRetryHeaders && appError.retryable) {
      this.setRetryHeaders(res, appError);
    }

    // Prepare response
    const response = this.prepareErrorResponse(appError, req);

    // Send response
    res.status(appError.statusCode).json(response);
  };

  // Handle async errors
  public asyncErrorHandler = (fn: Function) => {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  };

  // 404 handler
  public handle404 = (req: Request, res: Response, next: NextFunction): void => {
    const error = new AppError(
      ErrorType.NOT_FOUND_ERROR,
      `Route not found: ${req.method} ${req.path}`,
      {
        context: createErrorContext(req),
        userMessage: 'The requested resource was not found',
        code: 'ROUTE_NOT_FOUND'
      }
    );

    this.handleError(error, req, res, next);
  };

  // Handle unhandled promise rejections
  public handleUnhandledRejection = (reason: any, promise: Promise<any>): void => {
    const error = new AppError(
      ErrorType.INTERNAL_SERVER_ERROR,
      `Unhandled promise rejection: ${reason}`,
      {
        severity: ErrorSeverity.CRITICAL,
        code: 'UNHANDLED_REJECTION'
      }
    );

    loggingService.logError(error, undefined, {
      reason: reason?.toString(),
      stack: reason?.stack
    });

    // In production, we might want to exit gracefully
    if (process.env.NODE_ENV === 'production') {
      console.error('Unhandled Promise Rejection. Shutting down gracefully...');
      process.exit(1);
    }
  };

  // Handle uncaught exceptions
  public handleUncaughtException = (error: Error): void => {
    const appError = new AppError(
      ErrorType.INTERNAL_SERVER_ERROR,
      `Uncaught exception: ${error.message}`,
      {
        severity: ErrorSeverity.CRITICAL,
        code: 'UNCAUGHT_EXCEPTION'
      }
    );

    loggingService.logError(appError, undefined, {
      originalMessage: error.message,
      stack: error.stack
    });

    console.error('Uncaught Exception. Shutting down gracefully...');
    process.exit(1);
  };

  // Validation error handler for express-validator
  public handleValidationErrors = (req: Request, res: Response, next: NextFunction): void => {
    const { validationResult } = require('express-validator');
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      const validationErrors = errors.array();
      const firstError = validationErrors[0];
      
      const error = new AppError(
        ErrorType.VALIDATION_ERROR,
        `Validation failed: ${firstError.msg}`,
        {
          context: createErrorContext(req),
          userMessage: `Invalid ${firstError.path}: ${firstError.msg}`,
          code: 'VALIDATION_FAILED'
        }
      );

      // Add validation details to error context
      error.context.additionalData = {
        validationErrors: validationErrors.map((err: any) => ({
          field: err.path,
          message: err.msg,
          value: err.value
        }))
      };

      this.handleError(error, req, res, next);
      return;
    }

    next();
  };

  private convertToAppError(error: Error, req: Request): AppError {
    const context = createErrorContext(req);

    // Handle specific error types
    if (error.name === 'ValidationError') {
      return new AppError(ErrorType.VALIDATION_ERROR, error.message, {
        context,
        userMessage: 'Invalid input provided',
        code: 'VALIDATION_ERROR'
      });
    }

    if (error.name === 'CastError' || error.name === 'MongoError') {
      return new AppError(ErrorType.DATABASE_ERROR, error.message, {
        context,
        severity: ErrorSeverity.HIGH,
        userMessage: 'Database operation failed',
        code: 'DATABASE_ERROR',
        retryable: true
      });
    }

    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return new AppError(ErrorType.AUTHENTICATION_ERROR, error.message, {
        context,
        userMessage: 'Authentication token is invalid or expired',
        code: 'TOKEN_ERROR'
      });
    }

    if (error.name === 'MulterError') {
      return new AppError(ErrorType.FILE_UPLOAD_ERROR, error.message, {
        context,
        userMessage: 'File upload failed',
        code: 'FILE_UPLOAD_ERROR'
      });
    }

    if (error.message.includes('timeout') || error.name === 'TimeoutError') {
      return new AppError(ErrorType.TIMEOUT_ERROR, error.message, {
        context,
        severity: ErrorSeverity.HIGH,
        userMessage: 'Operation timed out',
        code: 'TIMEOUT_ERROR',
        retryable: true
      });
    }

    // Default to internal server error
    return new AppError(ErrorType.INTERNAL_SERVER_ERROR, error.message, {
      context,
      severity: ErrorSeverity.HIGH,
      userMessage: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
      cause: error
    });
  }

  private isSecurityError(error: AppError): boolean {
    return [
      ErrorType.AUTHENTICATION_ERROR,
      ErrorType.AUTHORIZATION_ERROR,
      ErrorType.SECURITY_ERROR,
      ErrorType.RATE_LIMIT_ERROR
    ].includes(error.type);
  }

  private logSecurityEvent(error: AppError, req: Request): void {
    let eventType: SecurityEventType;
    let riskLevel: SecurityRiskLevel;

    switch (error.type) {
      case ErrorType.AUTHENTICATION_ERROR:
        eventType = SecurityEventType.LOGIN_FAILURE;
        riskLevel = SecurityRiskLevel.MEDIUM;
        break;
      case ErrorType.AUTHORIZATION_ERROR:
        eventType = SecurityEventType.PERMISSION_DENIED;
        riskLevel = SecurityRiskLevel.HIGH;
        break;
      case ErrorType.SECURITY_ERROR:
        eventType = SecurityEventType.SUSPICIOUS_ACTIVITY;
        riskLevel = SecurityRiskLevel.CRITICAL;
        break;
      case ErrorType.RATE_LIMIT_ERROR:
        eventType = SecurityEventType.RATE_LIMIT_EXCEEDED;
        riskLevel = SecurityRiskLevel.MEDIUM;
        break;
      default:
        eventType = SecurityEventType.SUSPICIOUS_ACTIVITY;
        riskLevel = SecurityRiskLevel.MEDIUM;
    }

    securityService.logSecurityEvent({
      type: eventType,
      riskLevel,
      ip: error.context.ip || 'unknown',
      userAgent: error.context.userAgent,
      details: {
        errorType: error.type,
        errorCode: error.code,
        message: error.message,
        path: error.context.path,
        method: error.context.method,
        userId: error.context.userId
      }
    });

    // Record failed login attempts
    if (error.type === ErrorType.AUTHENTICATION_ERROR && error.context.userId) {
      securityService.recordFailedLogin(error.context.userId, error.context.ip || 'unknown');
    }
  }

  private setSecurityHeaders(res: Response, error: AppError): void {
    // Add security headers to error responses
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block'
    });

    // Add request ID header for tracking
    if (error.context.requestId) {
      res.set('X-Request-ID', error.context.requestId);
    }
  }

  private setRetryHeaders(res: Response, error: AppError): void {
    if (error.retryable) {
      // Set retry-after header based on error type
      let retryAfter = 60; // Default 1 minute

      switch (error.type) {
        case ErrorType.RATE_LIMIT_ERROR:
          retryAfter = 300; // 5 minutes
          break;
        case ErrorType.EXTERNAL_SERVICE_ERROR:
          retryAfter = 120; // 2 minutes
          break;
        case ErrorType.DATABASE_ERROR:
          retryAfter = 30; // 30 seconds
          break;
        case ErrorType.TIMEOUT_ERROR:
          retryAfter = 60; // 1 minute
          break;
      }

      res.set('Retry-After', retryAfter.toString());
    }
  }

  private prepareErrorResponse(error: AppError, req: Request): any {
    const baseResponse = {
      error: error.code,
      message: error.userMessage || error.message,
      type: error.type,
      timestamp: error.context.timestamp,
      requestId: error.context.requestId,
      retryable: error.retryable
    };

    // Add additional information in development
    if (this.options.includeStackTrace && process.env.NODE_ENV === 'development') {
      (baseResponse as any).stack = error.stack;
      (baseResponse as any).context = error.context;
    }

    // Add specific error details based on type
    if (error.type === ErrorType.VALIDATION_ERROR && error.context.additionalData?.validationErrors) {
      (baseResponse as any).validationErrors = error.context.additionalData.validationErrors;
    }

    if (error.type === ErrorType.RATE_LIMIT_ERROR && error.context.additionalData) {
      (baseResponse as any).rateLimit = {
        limit: error.context.additionalData.limit,
        windowMs: error.context.additionalData.windowMs
      };
    }

    return baseResponse;
  }

  // Health check for error handling system
  public getHealthCheck(): any {
    const performanceMetrics = loggingService.getPerformanceMetrics();
    
    return {
      status: performanceMetrics.errorRate > 10 ? 'warning' : 'healthy',
      metrics: performanceMetrics,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
  }
}

// Export singleton instance
export default new ErrorHandlingMiddleware();

// Export the class for custom instances
export { ErrorHandlingMiddleware };