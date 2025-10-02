// Enhanced logging service with structured logging
import winston from 'winston';
import path from 'path';
import { Request, Response } from 'express';
import { AppError, ErrorMetadata, ErrorSeverity } from '../utils/errors';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  HTTP = 'http',
  DEBUG = 'debug'
}

export enum LogCategory {
  SYSTEM = 'system',
  SECURITY = 'security',
  PERFORMANCE = 'performance',
  DATABASE = 'database',
  API = 'api',
  AUTHENTICATION = 'authentication',
  PAYMENT = 'payment',
  USER_ACTION = 'user_action',
  EXTERNAL_SERVICE = 'external_service',
  FILE_UPLOAD = 'file_upload'
}

export interface LogEntry {
  level: LogLevel;
  category: LogCategory;
  message: string;
  timestamp: Date;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  responseTime?: number;
  error?: ErrorMetadata;
  metadata?: Record<string, any>;
}

export interface PerformanceMetrics {
  requestCount: number;
  averageResponseTime: number;
  errorRate: number;
  slowQueries: number;
  memoryUsage: NodeJS.MemoryUsage;
  uptime: number;
}

class LoggingService {
  private logger: winston.Logger;
  private performanceMetrics: Map<string, number[]> = new Map();
  private errorCounts: Map<string, number> = new Map();
  private requestCounts: Map<string, number> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    this.logger = this.createLogger();
    this.setupPerformanceTracking();
  }

  private createLogger(): winston.Logger {
    const logDir = process.env.LOG_DIR || 'logs';
    const logLevel = process.env.LOG_LEVEL || 'INFO' as LogLevel;

    // Custom format for structured logging
    const customFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
      winston.format.printf(({ timestamp, level, message, category, requestId, userId, error, metadata, ...rest }) => {
        const logObject: any = {
          timestamp,
          level,
          message,
          category,
          requestId,
          userId,
          ...rest
        };

        if (error) {
          logObject.error = error;
        }

        if (metadata) {
          logObject.metadata = metadata;
        }

        return JSON.stringify(logObject);
      })
    );

    // Console format for development
    const consoleFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, category, requestId, userId }) => {
        let logMessage = `${timestamp} [${level}]`;
        if (category) logMessage += ` [${category}]`;
        if (requestId) logMessage += ` [${requestId}]`;
        if (userId) logMessage += ` [User:${userId}]`;
        logMessage += `: ${message}`;
        return logMessage;
      })
    );

    const transports: winston.transport[] = [];

    // Console transport for development
    if (process.env.NODE_ENV !== 'production') {
      transports.push(
        new winston.transports.Console({
          format: consoleFormat,
          level: 'debug'
        })
      );
    }

    // File transports for production
    if (process.env.NODE_ENV === 'production') {
      transports.push(
        // General application logs
        new winston.transports.File({
          filename: path.join(logDir, 'application.log'),
          format: customFormat,
          level: logLevel,
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10,
          tailable: true
        }),

        // Error logs
        new winston.transports.File({
          filename: path.join(logDir, 'error.log'),
          format: customFormat,
          level: 'error',
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 5,
          tailable: true
        }),

        // Security logs
        new winston.transports.File({
          filename: path.join(logDir, 'security.log'),
          format: customFormat,
          level: 'INFO' as LogLevel,
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10,
          tailable: true
        }),

        // Performance logs
        new winston.transports.File({
          filename: path.join(logDir, 'performance.log'),
          format: customFormat,
          level: 'INFO' as LogLevel,
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 5,
          tailable: true
        })
      );
    } else {
      // Development file logging
      transports.push(
        new winston.transports.File({
          filename: path.join(logDir, 'development.log'),
          format: customFormat,
          level: 'debug',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3
        })
      );
    }

    return winston.createLogger({
      level: logLevel,
      format: customFormat,
      transports,
      exitOnError: false,
      handleExceptions: true,
      handleRejections: true
    });
  }

  private setupPerformanceTracking(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    // Clean up old metrics every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldMetrics();
    }, 60 * 60 * 1000);
  }

  private cleanupOldMetrics(): void {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    // Keep only recent performance metrics
    this.performanceMetrics.forEach((times, key) => {
      this.performanceMetrics.set(key, times.filter(time => time > oneHourAgo));
    });

    // Reset error and request counts periodically
    this.errorCounts.clear();
    this.requestCounts.clear();
  }

  public log(level: LogLevel, category: LogCategory, message: string, metadata?: Record<string, any>): void {
    const logEntry: LogEntry = {
      level,
      category,
      message,
      timestamp: new Date(),
      metadata
    };

    this.logger.log(level, message, {
      category,
      timestamp: logEntry.timestamp,
      metadata
    });
  }

  public logWithContext(
    level: LogLevel,
    category: LogCategory,
    message: string,
    req?: Request,
    metadata?: Record<string, any>
  ): void {
    const requestId = req?.headers['x-request-id'] as string || Math.random().toString(36).substring(2);
    const userId = (req as any)?.user?.id;
    const sessionId = req?.headers['x-session-id'] as string;
    const ip = (req?.headers['x-forwarded-for'] as string) || req?.socket.remoteAddress;
    const userAgent = req?.headers['user-agent'];

    this.logger.log(level, message, {
      category,
      requestId,
      userId,
      sessionId,
      ip,
      userAgent,
      path: req?.path,
      method: req?.method,
      metadata
    });
  }

  public logError(error: Error | AppError, req?: Request, metadata?: Record<string, any>): void {
    const requestId = req?.headers['x-request-id'] as string || Math.random().toString(36).substring(2);
    const userId = (req as any)?.user?.id;
    
    let errorMetadata: ErrorMetadata | undefined;
    let category = LogCategory.SYSTEM;
    let severity = ErrorSeverity.MEDIUM;

    if (error instanceof AppError) {
      errorMetadata = error.toJSON();
      category = this.getLogCategoryFromErrorType(error.type);
      severity = error.severity;
      
      // Track error counts
      const errorKey = `${error.type}_${Date.now() - (Date.now() % (60 * 60 * 1000))}`;
      this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);
    }

    this.logger.error(error.message, {
      category,
      requestId,
      userId,
      sessionId: req?.headers['x-session-id'],
      ip: (req?.headers['x-forwarded-for'] as string) || req?.socket.remoteAddress,
      userAgent: req?.headers['user-agent'],
      path: req?.path,
      method: req?.method,
      error: errorMetadata,
      severity,
      stack: error.stack,
      metadata
    });

    // Log critical errors to security log as well
    if (severity === ErrorSeverity.CRITICAL) {
      this.logSecurity('Critical error occurred', {
        error: error.message,
        requestId,
        userId,
        stack: error.stack,
        ...metadata
      });
    }
  }

  public logRequest(req: Request, res: Response, responseTime: number): void {
    const requestId = req.headers['x-request-id'] as string || Math.random().toString(36).substring(2);
    const userId = (req as any)?.user?.id;
    const statusCode = res.statusCode;
    const contentLength = res.get('content-length') || '0';

    // Track request metrics
    const endpoint = `${req.method} ${req.route?.path || req.path}`;
    const performanceKey = `${endpoint}_${Date.now() - (Date.now() % (60 * 60 * 1000))}`;
    
    if (!this.performanceMetrics.has(performanceKey)) {
      this.performanceMetrics.set(performanceKey, []);
    }
    this.performanceMetrics.get(performanceKey)!.push(responseTime);

    // Track request counts
    const requestKey = `${endpoint}_${Date.now() - (Date.now() % (60 * 60 * 1000))}`;
    this.requestCounts.set(requestKey, (this.requestCounts.get(requestKey) || 0) + 1);

    const level = statusCode >= 500 ? LogLevel.ERROR : statusCode >= 400 ? LogLevel.WARN : LogLevel.INFO;
    
    this.logger.log(level, `${req.method} ${req.path} ${statusCode} - ${responseTime}ms`, {
      category: LogCategory.API,
      requestId,
      userId,
      sessionId: req.headers['x-session-id'],
      ip: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      path: req.path,
      method: req.method,
      statusCode,
      responseTime,
      contentLength: parseInt(contentLength),
      referer: req.headers.referer
    });

    // Log slow requests
    if (responseTime > 5000) { // 5 seconds
      this.logPerformance(`Slow request detected: ${endpoint}`, {
        responseTime,
        endpoint,
        requestId,
        userId
      });
    }
  }

  public logSecurity(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, LogCategory.SECURITY, message, metadata);
  }

  public logPerformance(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.PERFORMANCE, message, metadata);
  }

  public logDatabase(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.DATABASE, message, metadata);
  }

  public logAuthentication(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.AUTHENTICATION, message, metadata);
  }

  public logPayment(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.PAYMENT, message, metadata);
  }

  public logUserAction(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.USER_ACTION, message, metadata);
  }

  public logExternalService(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.EXTERNAL_SERVICE, message, metadata);
  }

  public logFileUpload(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, LogCategory.FILE_UPLOAD, message, metadata);
  }

  private getLogCategoryFromErrorType(errorType: string): LogCategory {
    const categoryMap: Record<string, LogCategory> = {
      'AUTHENTICATION_ERROR': LogCategory.AUTHENTICATION,
      'AUTHORIZATION_ERROR': LogCategory.AUTHENTICATION,
      'SECURITY_ERROR': LogCategory.SECURITY,
      'DATABASE_ERROR': LogCategory.DATABASE,
      'PAYMENT_ERROR': LogCategory.PAYMENT,
      'EXTERNAL_SERVICE_ERROR': LogCategory.EXTERNAL_SERVICE,
      'FILE_UPLOAD_ERROR': LogCategory.FILE_UPLOAD
    };

    return categoryMap[errorType] || LogCategory.SYSTEM;
  }

  public getPerformanceMetrics(): PerformanceMetrics {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    let totalRequests = 0;
    let totalResponseTime = 0;
    let totalErrors = 0;
    let slowQueries = 0;

    // Calculate request metrics
    this.requestCounts.forEach((count, key) => {
      totalRequests += count;
    });

    // Calculate response time metrics
    this.performanceMetrics.forEach((times, key) => {
      times.forEach(time => {
        totalResponseTime += time;
        if (time > 5000) slowQueries++; // Count slow requests
      });
    });

    // Calculate error metrics
    this.errorCounts.forEach((count, key) => {
      totalErrors += count;
    });

    const averageResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

    return {
      requestCount: totalRequests,
      averageResponseTime: Math.round(averageResponseTime),
      errorRate: Math.round(errorRate * 100) / 100,
      slowQueries,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime()
    };
  }

  public exportLogs(startDate: Date, endDate: Date, categories?: LogCategory[]): Promise<LogEntry[]> {
    // This would typically query a log storage system
    // For now, return a promise that would contain filtered logs
    return new Promise((resolve) => {
      // Implementation would depend on log storage backend
      resolve([]);
    });
  }

  public getLogger(): winston.Logger {
    return this.logger;
  }
}

export default new LoggingService();