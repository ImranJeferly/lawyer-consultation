import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import validator from 'validator';
// @ts-ignore - xss doesn't have official types
import xss from 'xss';
import { body, query, param, validationResult } from 'express-validator';

// Enhanced security headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "'strict-dynamic'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      childSrc: ["'none'"],
      workerSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      manifestSrc: ["'self'"]
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for file uploads
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
});

// Input sanitization middleware
export const sanitizeInput = (req: Request, res: Response, next: NextFunction) => {
  const sanitizeObject = (obj: any): any => {
    if (typeof obj === 'string') {
      // Remove XSS attempts and normalize
      return xss(obj, {
        whiteList: {}, // No HTML tags allowed
        stripIgnoreTag: true,
        stripIgnoreTagBody: ['script']
      }).trim();
    }
    
    if (Array.isArray(obj)) {
      return obj.map(sanitizeObject);
    }
    
    if (obj && typeof obj === 'object') {
      const sanitized: any = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          sanitized[key] = sanitizeObject(obj[key]);
        }
      }
      return sanitized;
    }
    
    return obj;
  };

  try {
    // Sanitize request body
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    // Sanitize query parameters (create new object to avoid read-only issues)
    if (req.query && Object.keys(req.query).length > 0) {
      const sanitizedQuery: any = {};
      for (const key in req.query) {
        if (req.query.hasOwnProperty(key)) {
          sanitizedQuery[key] = sanitizeObject(req.query[key]);
        }
      }
      // Replace query with sanitized version
      (req as any).query = sanitizedQuery;
    }

    // Sanitize URL parameters (create new object to avoid read-only issues)
    if (req.params && Object.keys(req.params).length > 0) {
      const sanitizedParams: any = {};
      for (const key in req.params) {
        if (req.params.hasOwnProperty(key)) {
          sanitizedParams[key] = sanitizeObject(req.params[key]);
        }
      }
      // Replace params with sanitized version
      (req as any).params = sanitizedParams;
    }
  } catch (error) {
    // If sanitization fails, log and continue
    console.warn('Input sanitization warning:', (error as Error).message);
  }

  next();
};

// SQL injection prevention middleware
export const preventSQLInjection = (req: Request, res: Response, next: NextFunction) => {
  const checkForSQLInjection = (value: string): boolean => {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi,
      /('|(\\')|('')|(%27)|(%2527))/gi,
      /("|(\\")|("")|(%22)|(%2522))/gi,
      /(\b(OR|AND)\b.*[=<>])/gi,
      /(;|--|\|\||&&)/gi,
      /\b(xp_|sp_|exec|execute)\b/gi
    ];
    
    return sqlPatterns.some(pattern => pattern.test(value));
  };

  const scanObject = (obj: any, path: string = ''): string | null => {
    if (typeof obj === 'string') {
      if (checkForSQLInjection(obj)) {
        return path || 'root';
      }
    }
    
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const result = scanObject(obj[i], `${path}[${i}]`);
        if (result) return result;
      }
    }
    
    if (obj && typeof obj === 'object') {
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const result = scanObject(obj[key], path ? `${path}.${key}` : key);
          if (result) return result;
        }
      }
    }
    
    return null;
  };

  // Check all input sources
  const sources = [
    { data: req.body, name: 'body' },
    { data: req.query, name: 'query' },
    { data: req.params, name: 'params' }
  ];

  for (const source of sources) {
    if (source.data) {
      const suspiciousField = scanObject(source.data);
      if (suspiciousField) {
        return res.status(400).json({
          error: 'Invalid Input',
          message: 'Potential SQL injection detected',
          field: `${source.name}.${suspiciousField}`,
          code: 'SECURITY_VIOLATION'
        });
      }
    }
  }

  next();
};

// File upload security middleware
export const secureFileUpload = (req: Request, res: Response, next: NextFunction) => {
  if (req.file || req.files) {
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain'
    ];

    const maxFileSize = 10 * 1024 * 1024; // 10MB
    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.php', '.asp', '.jsp', '.js', '.html'];

    const validateFile = (file: any) => {
      // Check file size
      if (file.size > maxFileSize) {
        throw new Error(`File too large: ${file.originalname}`);
      }

      // Check MIME type
      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new Error(`Invalid file type: ${file.mimetype}`);
      }

      // Check file extension
      const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
      if (dangerousExtensions.includes(fileExtension)) {
        throw new Error(`Dangerous file extension: ${fileExtension}`);
      }

      // Check for null bytes (potential path traversal)
      if (file.originalname.includes('\0')) {
        throw new Error('Invalid filename: null byte detected');
      }

      // Check filename length
      if (file.originalname.length > 255) {
        throw new Error('Filename too long');
      }
    };

    try {
      if (req.file) {
        validateFile(req.file);
      }

      if (req.files) {
        if (Array.isArray(req.files)) {
          req.files.forEach(validateFile);
        } else {
          Object.values(req.files).flat().forEach(validateFile);
        }
      }
    } catch (error) {
      return res.status(400).json({
        error: 'File Upload Error',
        message: (error as Error).message,
        code: 'INVALID_FILE'
      });
    }
  }

  next();
};

// API key validation middleware
export const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] as string;
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required',
      code: 'MISSING_API_KEY'
    });
  }

  // In production, validate against database or secure store
  const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];
  
  if (!validApiKeys.includes(apiKey)) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
      code: 'INVALID_API_KEY'
    });
  }

  next();
};

// Request validation schemas
export const commonValidations = {
  // Email validation
  email: body('email')
    .isEmail()
    .normalizeEmail()
    .isLength({ max: 255 })
    .withMessage('Valid email address required'),

  // Password validation
  password: body('password')
    .isLength({ min: 8, max: 128 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must be 8+ chars with uppercase, lowercase, number, and special character'),

  // Phone validation
  phone: body('phone')
    .optional()
    .isMobilePhone('any')
    .withMessage('Valid phone number required'),

  // Name validation
  name: (field: string) => body(field)
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z\s'-]+$/)
    .withMessage(`${field} must contain only letters, spaces, hyphens, and apostrophes`),

  // ID validation
  id: (field: string = 'id') => param(field)
    .isUUID()
    .withMessage(`Valid ${field} required`),

  // Amount validation (for payments)
  amount: body('amount')
    .isFloat({ min: 0.01, max: 999999.99 })
    .withMessage('Amount must be between 0.01 and 999999.99'),

  // Search query validation
  searchQuery: query('query')
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9\s\-_.]+$/)
    .withMessage('Search query contains invalid characters'),

  // Pagination validation
  pagination: [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],

  // Date validation
  date: (field: string) => body(field)
    .isISO8601()
    .toDate()
    .withMessage(`Valid ${field} date required`),

  // URL validation
  url: (field: string) => body(field)
    .optional()
    .isURL({ protocols: ['http', 'https'] })
    .withMessage(`Valid ${field} URL required`)
};

// Enhanced validation error handler
export const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(error => ({
      field: error.type === 'field' ? error.path : 'unknown',
      message: error.msg,
      value: error.type === 'field' ? error.value : undefined,
      location: error.type === 'field' ? error.location : 'unknown'
    }));

    return res.status(400).json({
      error: 'Validation Error',
      message: 'Input validation failed',
      details: formattedErrors,
      code: 'VALIDATION_FAILED'
    });
  }

  next();
};

// CORS security enhancement
export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
    
    // Allow requests with no origin (mobile apps, etc.) or in development
    if (!origin || process.env.NODE_ENV === 'test') {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // In development, log the rejected origin for debugging
      if (process.env.NODE_ENV === 'development') {
        console.warn(`CORS rejected origin: ${origin}`);
      }
      callback(null, false); // Don't throw error, just reject
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-API-Key',
    'X-Client-Version'
  ],
  exposedHeaders: [
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset'
  ]
};

// Request size limiting middleware
export const requestSizeLimit = (maxSize: string = '10mb') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = req.headers['content-length'];
    const maxBytes = parseSize(maxSize);
    
    if (contentLength && parseInt(contentLength) > maxBytes) {
      return res.status(413).json({
        error: 'Request Too Large',
        message: `Request size exceeds maximum allowed size of ${maxSize}`,
        code: 'REQUEST_TOO_LARGE'
      });
    }
    
    next();
  };
};

// Helper function to parse size strings
function parseSize(size: string): number {
  const units: { [key: string]: number } = {
    'b': 1,
    'kb': 1024,
    'mb': 1024 * 1024,
    'gb': 1024 * 1024 * 1024
  };
  
  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
  if (!match) return 10 * 1024 * 1024; // Default 10MB
  
  const value = parseFloat(match[1]);
  const unit = match[2] || 'b';
  
  return Math.floor(value * units[unit]);
}

// Security audit logging middleware
export const securityAuditLog = (req: Request, res: Response, next: NextFunction) => {
  const securityEvents = ['login', 'logout', 'register', 'password-reset', 'payment', 'admin'];
  const path = req.path.toLowerCase();
  
  const isSecurityEvent = securityEvents.some(event => path.includes(event));
  
  if (isSecurityEvent) {
    const auditData = {
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      method: req.method,
      path: req.path,
      userId: req.user?.id || 'anonymous',
      sessionId: req.headers['x-session-id'],
      requestId: req.headers['x-request-id'] || Math.random().toString(36).substring(2)
    };
    
    // In production, send to security logging service
    console.log('SECURITY_AUDIT:', JSON.stringify(auditData));
  }
  
  next();
};

export default {
  securityHeaders,
  sanitizeInput,
  preventSQLInjection,
  secureFileUpload,
  validateApiKey,
  commonValidations,
  handleValidationErrors,
  corsOptions,
  requestSizeLimit,
  securityAuditLog
};