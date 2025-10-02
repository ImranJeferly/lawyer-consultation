// Security configuration and constants
export const SECURITY_CONFIG = {
  // Password requirements
  PASSWORD: {
    MIN_LENGTH: 8,
    MAX_LENGTH: 128,
    PATTERN: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
    SALT_ROUNDS: 12
  },

  // File upload limits
  FILE_UPLOAD: {
    MAX_SIZE: 10 * 1024 * 1024, // 10MB
    ALLOWED_MIME_TYPES: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain'
    ],
    DANGEROUS_EXTENSIONS: ['.exe', '.bat', '.cmd', '.sh', '.php', '.asp', '.jsp', '.js', '.html', '.scr', '.vbs']
  },

  // Request limits
  REQUEST: {
    MAX_SIZE: '10mb',
    MAX_FIELDS: 100,
    MAX_FILES: 10,
    TIMEOUT: 30000 // 30 seconds
  },

  // Session security
  SESSION: {
    MAX_AGE: 24 * 60 * 60 * 1000, // 24 hours
    SECURE: process.env.NODE_ENV === 'production',
    HTTP_ONLY: true,
    SAME_SITE: 'strict' as const
  },

  // JWT settings
  JWT: {
    ACCESS_TOKEN_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY: '7d',
    ALGORITHM: 'HS256' as const
  },

  // CORS settings
  CORS: {
    MAX_AGE: 86400, // 24 hours
    CREDENTIALS: true
  },

  // Security headers
  HEADERS: {
    HSTS_MAX_AGE: 31536000, // 1 year
    CSP_REPORT_ONLY: process.env.NODE_ENV !== 'production'
  },

  // Audit settings
  AUDIT: {
    SENSITIVE_PATHS: ['/auth', '/admin', '/payment', '/user', '/booking'],
    LOG_RETENTION_DAYS: 90,
    MAX_LOG_SIZE: '100mb'
  },

  // Encryption settings
  ENCRYPTION: {
    ALGORITHM: 'aes-256-gcm',
    KEY_LENGTH: 32,
    IV_LENGTH: 16,
    TAG_LENGTH: 16
  }
};

// Security risk levels
export enum SecurityRiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

// Security event types
export enum SecurityEventType {
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILURE = 'login_failure',
  LOGOUT = 'logout',
  PASSWORD_RESET = 'password_reset',
  ACCOUNT_LOCKED = 'account_locked',
  PERMISSION_DENIED = 'permission_denied',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  FILE_UPLOAD = 'file_upload',
  DATA_EXPORT = 'data_export',
  ADMIN_ACTION = 'admin_action',
  API_KEY_USED = 'api_key_used',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  SQL_INJECTION_ATTEMPT = 'sql_injection_attempt',
  XSS_ATTEMPT = 'xss_attempt'
}

export default SECURITY_CONFIG;