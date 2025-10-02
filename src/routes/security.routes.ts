import { Router, Request, Response } from 'express';
import SecurityService from '../services/security.service';
import { SecurityEventType, SecurityRiskLevel } from '../config/security.config';

// Helper function to get client IP
const getClientIP = (req: Request): string => {
  return (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
};

const router = Router();

// Get security metrics (admin only)
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = SecurityService.getSecurityMetrics();
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve security metrics',
      message: (error as Error).message
    });
  }
});

// Get suspicious IPs (admin only)
router.get('/suspicious-ips', async (req: Request, res: Response) => {
  try {
    const suspiciousIPs = SecurityService.getSuspiciousIPs();
    res.json({
      success: true,
      data: {
        count: suspiciousIPs.length,
        ips: suspiciousIPs
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve suspicious IPs',
      message: (error as Error).message
    });
  }
});

// Check if IP is suspicious
router.get('/check-ip/:ip', async (req: Request, res: Response) => {
  try {
    const { ip } = req.params;
    const isSuspicious = SecurityService.isSuspiciousIP(ip);
    
    res.json({
      success: true,
      data: {
        ip,
        suspicious: isSuspicious
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check IP status',
      message: (error as Error).message
    });
  }
});

// Generate secure password
router.post('/generate-password', async (req: Request, res: Response) => {
  try {
    const { length = 16 } = req.body;
    
    if (length < 8 || length > 64) {
      return res.status(400).json({
        error: 'Invalid password length',
        message: 'Password length must be between 8 and 64 characters'
      });
    }
    
    const password = SecurityService.generateSecurePassword(length);
    const strength = SecurityService.validatePasswordStrength(password);
    
    res.json({
      success: true,
      data: {
        password,
        strength
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate password',
      message: (error as Error).message
    });
  }
});

// Validate password strength
router.post('/validate-password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({
        error: 'Password required',
        message: 'Password field is required'
      });
    }
    
    const validation = SecurityService.validatePasswordStrength(password);
    
    res.json({
      success: true,
      data: validation
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to validate password',
      message: (error as Error).message
    });
  }
});

// Generate secure token
router.post('/generate-token', async (req: Request, res: Response) => {
  try {
    const { length = 32 } = req.body;
    
    if (length < 16 || length > 128) {
      return res.status(400).json({
        error: 'Invalid token length',
        message: 'Token length must be between 16 and 128 characters'
      });
    }
    
    const token = SecurityService.generateSecureToken(length);
    
    res.json({
      success: true,
      data: {
        token,
        length: token.length
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate token',
      message: (error as Error).message
    });
  }
});

// Clear failed login attempts (admin only)
router.post('/clear-failed-logins', async (req: Request, res: Response) => {
  try {
    const { identifier, ip } = req.body;
    
    if (!identifier || !ip) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both identifier and ip are required'
      });
    }
    
    SecurityService.clearFailedLoginAttempts(identifier, ip);
    
    // Log security event
    SecurityService.logSecurityEvent({
      type: SecurityEventType.ADMIN_ACTION,
      riskLevel: SecurityRiskLevel.MEDIUM,
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'],
      details: {
        action: 'clear_failed_logins',
        target_identifier: identifier,
        target_ip: ip
      }
    });
    
    res.json({
      success: true,
      message: 'Failed login attempts cleared'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to clear login attempts',
      message: (error as Error).message
    });
  }
});

// Check if account is locked
router.get('/check-lock/:identifier/:ip', async (req: Request, res: Response) => {
  try {
    const { identifier, ip } = req.params;
    const isLocked = SecurityService.isAccountLocked(identifier, ip);
    
    res.json({
      success: true,
      data: {
        identifier,
        ip,
        locked: isLocked
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check account lock status',
      message: (error as Error).message
    });
  }
});

// Manual security event logging (for testing/debugging)
router.post('/log-event', async (req: Request, res: Response) => {
  try {
    const { type, riskLevel, details } = req.body;
    
    if (!Object.values(SecurityEventType).includes(type)) {
      return res.status(400).json({
        error: 'Invalid event type',
        message: 'Event type must be one of the defined SecurityEventType values'
      });
    }
    
    if (!Object.values(SecurityRiskLevel).includes(riskLevel)) {
      return res.status(400).json({
        error: 'Invalid risk level',
        message: 'Risk level must be one of the defined SecurityRiskLevel values'
      });
    }
    
    SecurityService.logSecurityEvent({
      type,
      riskLevel,
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'],
      details: details || {}
    });
    
    res.json({
      success: true,
      message: 'Security event logged'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to log security event',
      message: (error as Error).message
    });
  }
});

// Cleanup expired security data
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    SecurityService.cleanup();
    
    // Log security event
    SecurityService.logSecurityEvent({
      type: SecurityEventType.ADMIN_ACTION,
      riskLevel: SecurityRiskLevel.LOW,
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'],
      details: {
        action: 'security_cleanup'
      }
    });
    
    res.json({
      success: true,
      message: 'Security data cleanup completed'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to cleanup security data',
      message: (error as Error).message
    });
  }
});

// Get security health status
router.get('/health', async (req: Request, res: Response) => {
  try {
    const metrics = SecurityService.getSecurityMetrics();
    const suspiciousIPCount = SecurityService.getSuspiciousIPs().length;
    
    // Determine health status based on metrics
    let status = 'healthy';
    const issues: string[] = [];
    
    if (suspiciousIPCount > 10) {
      status = 'warning';
      issues.push(`High number of suspicious IPs: ${suspiciousIPCount}`);
    }
    
    if (metrics.eventsByRiskLevel[SecurityRiskLevel.CRITICAL] > 0) {
      status = 'critical';
      issues.push(`Critical security events detected: ${metrics.eventsByRiskLevel[SecurityRiskLevel.CRITICAL]}`);
    }
    
    if (metrics.lockedAccounts > 5) {
      status = 'warning';
      issues.push(`Multiple locked accounts: ${metrics.lockedAccounts}`);
    }
    
    res.json({
      success: true,
      data: {
        status,
        issues,
        metrics: {
          totalEvents: metrics.totalEvents,
          suspiciousIPs: suspiciousIPCount,
          lockedAccounts: metrics.lockedAccounts,
          criticalEvents: metrics.eventsByRiskLevel[SecurityRiskLevel.CRITICAL] || 0,
          highRiskEvents: metrics.eventsByRiskLevel[SecurityRiskLevel.HIGH] || 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get security health status',
      message: (error as Error).message
    });
  }
});

export default router;