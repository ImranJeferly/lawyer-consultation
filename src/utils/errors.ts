// Enhanced error handling types and classes
import { Request, Response } from 'express';

export enum ErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  NOT_FOUND_ERROR = 'NOT_FOUND_ERROR',
  CONFLICT_ERROR = 'CONFLICT_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  FILE_UPLOAD_ERROR = 'FILE_UPLOAD_ERROR',
  PAYMENT_ERROR = 'PAYMENT_ERROR',
  SECURITY_ERROR = 'SECURITY_ERROR',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  BAD_REQUEST_ERROR = 'BAD_REQUEST_ERROR',
  SERVICE_UNAVAILABLE_ERROR = 'SERVICE_UNAVAILABLE_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR'
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export interface ErrorContext {
  userId?: string;
  requestId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  path?: string;
  method?: string;
  timestamp: Date;
  additionalData?: Record<string, any>;
}

export interface ErrorMetadata {
  type: ErrorType;
  severity: ErrorSeverity;
  code: string;
  message: string;
  context: ErrorContext;
  stack?: string;
  cause?: Error;
  retryable: boolean;
  userMessage?: string;
}

export class AppError extends Error {
  public readonly type: ErrorType;
  public readonly severity: ErrorSeverity;
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly retryable: boolean;
  public readonly userMessage?: string;
  public readonly statusCode: number;
  public readonly cause?: Error;

  constructor(
    type: ErrorType,
    message: string,
    options: {
      severity?: ErrorSeverity;
      code?: string;
      context?: Partial<ErrorContext>;
      retryable?: boolean;
      userMessage?: string;
      statusCode?: number;
      cause?: Error;
    } = {}
  ) {
    super(message);
    
    this.name = 'AppError';
    this.type = type;
    this.severity = options.severity || ErrorSeverity.MEDIUM;
    this.code = options.code || type;
    this.retryable = options.retryable || false;
    this.userMessage = options.userMessage;
    this.statusCode = options.statusCode || this.getDefaultStatusCode(type);
    this.cause = options.cause;
    
    this.context = {
      timestamp: new Date(),
      ...options.context
    };

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  private getDefaultStatusCode(type: ErrorType): number {
    const statusCodeMap: Record<ErrorType, number> = {
      [ErrorType.VALIDATION_ERROR]: 400,
      [ErrorType.BAD_REQUEST_ERROR]: 400,
      [ErrorType.AUTHENTICATION_ERROR]: 401,
      [ErrorType.AUTHORIZATION_ERROR]: 403,
      [ErrorType.NOT_FOUND_ERROR]: 404,
      [ErrorType.CONFLICT_ERROR]: 409,
      [ErrorType.RATE_LIMIT_ERROR]: 429,
      [ErrorType.INTERNAL_SERVER_ERROR]: 500,
      [ErrorType.DATABASE_ERROR]: 500,
      [ErrorType.EXTERNAL_SERVICE_ERROR]: 502,
      [ErrorType.SERVICE_UNAVAILABLE_ERROR]: 503,
      [ErrorType.TIMEOUT_ERROR]: 504,
      [ErrorType.FILE_UPLOAD_ERROR]: 400,
      [ErrorType.PAYMENT_ERROR]: 402,
      [ErrorType.SECURITY_ERROR]: 403
    };

    return statusCodeMap[type] || 500;
  }

  public toJSON(): ErrorMetadata {
    return {
      type: this.type,
      severity: this.severity,
      code: this.code,
      message: this.message,
      context: this.context,
      stack: this.stack,
      cause: this.cause,
      retryable: this.retryable,
      userMessage: this.userMessage
    };
  }

  public toClientResponse() {
    return {
      error: this.code,
      message: this.userMessage || this.message,
      type: this.type,
      retryable: this.retryable,
      timestamp: this.context.timestamp,
      requestId: this.context.requestId
    };
  }
}

// Specific error classes for common scenarios
export class ValidationError extends AppError {
  constructor(message: string, field?: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.VALIDATION_ERROR, message, {
      severity: ErrorSeverity.LOW,
      code: 'VALIDATION_FAILED',
      userMessage: `Validation failed: ${message}`,
      context: {
        ...options,
        additionalData: { field, ...options.additionalData }
      }
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required', options: Partial<ErrorContext> = {}) {
    super(ErrorType.AUTHENTICATION_ERROR, message, {
      severity: ErrorSeverity.HIGH,
      code: 'AUTH_REQUIRED',
      userMessage: 'Please log in to access this resource',
      context: options
    });
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions', options: Partial<ErrorContext> = {}) {
    super(ErrorType.AUTHORIZATION_ERROR, message, {
      severity: ErrorSeverity.HIGH,
      code: 'INSUFFICIENT_PERMISSIONS',
      userMessage: 'You do not have permission to access this resource',
      context: options
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.NOT_FOUND_ERROR, `${resource} not found`, {
      severity: ErrorSeverity.LOW,
      code: 'RESOURCE_NOT_FOUND',
      userMessage: `The requested ${resource.toLowerCase()} could not be found`,
      context: {
        ...options,
        additionalData: { resource, ...options.additionalData }
      }
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.CONFLICT_ERROR, message, {
      severity: ErrorSeverity.MEDIUM,
      code: 'RESOURCE_CONFLICT',
      userMessage: message,
      context: options
    });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, operation?: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.DATABASE_ERROR, message, {
      severity: ErrorSeverity.CRITICAL,
      code: 'DATABASE_ERROR',
      userMessage: 'A database error occurred. Please try again later.',
      retryable: true,
      context: {
        ...options,
        additionalData: { operation, ...options.additionalData }
      }
    });
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.EXTERNAL_SERVICE_ERROR, `${service}: ${message}`, {
      severity: ErrorSeverity.HIGH,
      code: 'EXTERNAL_SERVICE_ERROR',
      userMessage: 'An external service is currently unavailable. Please try again later.',
      retryable: true,
      context: {
        ...options,
        additionalData: { service, ...options.additionalData }
      }
    });
  }
}

export class PaymentError extends AppError {
  constructor(message: string, paymentMethod?: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.PAYMENT_ERROR, message, {
      severity: ErrorSeverity.HIGH,
      code: 'PAYMENT_FAILED',
      userMessage: 'Payment processing failed. Please check your payment details and try again.',
      context: {
        ...options,
        additionalData: { paymentMethod, ...options.additionalData }
      }
    });
  }
}

export class RateLimitError extends AppError {
  constructor(limit: number, windowMs: number, options: Partial<ErrorContext> = {}) {
    super(ErrorType.RATE_LIMIT_ERROR, `Rate limit exceeded: ${limit} requests per ${windowMs}ms`, {
      severity: ErrorSeverity.MEDIUM,
      code: 'RATE_LIMIT_EXCEEDED',
      userMessage: 'Too many requests. Please wait before trying again.',
      retryable: true,
      context: {
        ...options,
        additionalData: { limit, windowMs, ...options.additionalData }
      }
    });
  }
}

export class FileUploadError extends AppError {
  constructor(message: string, filename?: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.FILE_UPLOAD_ERROR, message, {
      severity: ErrorSeverity.MEDIUM,
      code: 'FILE_UPLOAD_FAILED',
      userMessage: 'File upload failed. Please check the file and try again.',
      context: {
        ...options,
        additionalData: { filename, ...options.additionalData }
      }
    });
  }
}

export class SecurityError extends AppError {
  constructor(message: string, securityEvent?: string, options: Partial<ErrorContext> = {}) {
    super(ErrorType.SECURITY_ERROR, message, {
      severity: ErrorSeverity.CRITICAL,
      code: 'SECURITY_VIOLATION',
      userMessage: 'Security violation detected. Access denied.',
      context: {
        ...options,
        additionalData: { securityEvent, ...options.additionalData }
      }
    });
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number, options: Partial<ErrorContext> = {}) {
    super(ErrorType.TIMEOUT_ERROR, `Operation timeout: ${operation} (${timeoutMs}ms)`, {
      severity: ErrorSeverity.HIGH,
      code: 'OPERATION_TIMEOUT',
      userMessage: 'The operation took too long to complete. Please try again.',
      retryable: true,
      context: {
        ...options,
        additionalData: { operation, timeoutMs, ...options.additionalData }
      }
    });
  }
}

// Helper function to create error context from Express request
export function createErrorContext(req: Request): ErrorContext {
  return {
    userId: (req as any).user?.id,
    requestId: req.headers['x-request-id'] as string || Math.random().toString(36).substring(2),
    sessionId: req.headers['x-session-id'] as string,
    ip: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'],
    path: req.path,
    method: req.method,
    timestamp: new Date()
  };
}

// Error factory for creating common errors with request context
export class ErrorFactory {
  static validation(message: string, field?: string, req?: Request): ValidationError {
    return new ValidationError(message, field, req ? createErrorContext(req) : {});
  }

  static authentication(message?: string, req?: Request): AuthenticationError {
    return new AuthenticationError(message, req ? createErrorContext(req) : {});
  }

  static authorization(message?: string, req?: Request): AuthorizationError {
    return new AuthorizationError(message, req ? createErrorContext(req) : {});
  }

  static notFound(resource: string, req?: Request): NotFoundError {
    return new NotFoundError(resource, req ? createErrorContext(req) : {});
  }

  static conflict(message: string, req?: Request): ConflictError {
    return new ConflictError(message, req ? createErrorContext(req) : {});
  }

  static database(message: string, operation?: string, req?: Request): DatabaseError {
    return new DatabaseError(message, operation, req ? createErrorContext(req) : {});
  }

  static externalService(service: string, message: string, req?: Request): ExternalServiceError {
    return new ExternalServiceError(service, message, req ? createErrorContext(req) : {});
  }

  static payment(message: string, paymentMethod?: string, req?: Request): PaymentError {
    return new PaymentError(message, paymentMethod, req ? createErrorContext(req) : {});
  }

  static rateLimit(limit: number, windowMs: number, req?: Request): RateLimitError {
    return new RateLimitError(limit, windowMs, req ? createErrorContext(req) : {});
  }

  static fileUpload(message: string, filename?: string, req?: Request): FileUploadError {
    return new FileUploadError(message, filename, req ? createErrorContext(req) : {});
  }

  static security(message: string, securityEvent?: string, req?: Request): SecurityError {
    return new SecurityError(message, securityEvent, req ? createErrorContext(req) : {});
  }

  static timeout(operation: string, timeoutMs: number, req?: Request): TimeoutError {
    return new TimeoutError(operation, timeoutMs, req ? createErrorContext(req) : {});
  }
}