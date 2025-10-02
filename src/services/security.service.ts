import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { SECURITY_CONFIG, SecurityEventType, SecurityRiskLevel } from '../config/security.config';

export interface SecurityEvent {
  type: SecurityEventType;
  riskLevel: SecurityRiskLevel;
  userId?: string;
  ip: string;
  userAgent?: string;
  details: Record<string, any>;
  timestamp: Date;
}



export class SecurityService {
  private static instance: SecurityService;
  private securityEvents: SecurityEvent[] = [];
  private suspiciousIPs: Map<string, number> = new Map();
  private failedLoginAttempts: Map<string, { count: number; lastAttempt: Date }> = new Map();

  private constructor() {}

  public static getInstance(): SecurityService {
    if (!SecurityService.instance) {
      SecurityService.instance = new SecurityService();
    }
    return SecurityService.instance;
  }

  // Password hashing and verification
  public async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SECURITY_CONFIG.PASSWORD.SALT_ROUNDS);
  }

  public async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  // Password strength validation
  public validatePasswordStrength(password: string): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (password.length < SECURITY_CONFIG.PASSWORD.MIN_LENGTH) {
      errors.push(`Password must be at least ${SECURITY_CONFIG.PASSWORD.MIN_LENGTH} characters long`);
    }

    if (password.length > SECURITY_CONFIG.PASSWORD.MAX_LENGTH) {
      errors.push(`Password must be no more than ${SECURITY_CONFIG.PASSWORD.MAX_LENGTH} characters long`);
    }

    if (!SECURITY_CONFIG.PASSWORD.PATTERN.test(password)) {
      errors.push('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character');
    }

    // Check for common weak passwords
    const commonPasswords = [
      'password', '123456', 'password123', 'admin', 'qwerty', 
      'letmein', 'welcome', 'monkey', '1234567890'
    ];

    if (commonPasswords.includes(password.toLowerCase())) {
      errors.push('Password is too common');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  // Simple data hashing for sensitive data
  public hashSensitiveData(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  public generateSecureHash(data: string, salt?: string): string {
    const useSalt = salt || crypto.randomBytes(16).toString('hex');
    return crypto.createHash('sha256').update(data + useSalt).digest('hex');
  }

  // Security event logging
  public logSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
    const securityEvent: SecurityEvent = {
      ...event,
      timestamp: new Date()
    };

    this.securityEvents.push(securityEvent);

    // Update suspicious IP tracking
    if (event.riskLevel === SecurityRiskLevel.HIGH || event.riskLevel === SecurityRiskLevel.CRITICAL) {
      const currentCount = this.suspiciousIPs.get(event.ip) || 0;
      this.suspiciousIPs.set(event.ip, currentCount + 1);
    }

    // In production, send to logging service
    console.log('SECURITY_EVENT:', JSON.stringify(securityEvent, null, 2));

    // Clean up old events (keep last 1000)
    if (this.securityEvents.length > 1000) {
      this.securityEvents = this.securityEvents.slice(-1000);
    }
  }

  // Failed login attempt tracking
  public recordFailedLogin(identifier: string, ip: string): boolean {
    const key = `${identifier}:${ip}`;
    const now = new Date();
    const existing = this.failedLoginAttempts.get(key);

    if (existing) {
      // Reset counter if last attempt was more than 1 hour ago
      if (now.getTime() - existing.lastAttempt.getTime() > 60 * 60 * 1000) {
        this.failedLoginAttempts.set(key, { count: 1, lastAttempt: now });
        return false;
      }

      existing.count++;
      existing.lastAttempt = now;

      // Account locked after 5 failed attempts
      if (existing.count >= 5) {
        this.logSecurityEvent({
          type: SecurityEventType.ACCOUNT_LOCKED,
          riskLevel: SecurityRiskLevel.HIGH,
          ip,
          details: { identifier, attempts: existing.count }
        });
        return true;
      }
    } else {
      this.failedLoginAttempts.set(key, { count: 1, lastAttempt: now });
    }

    return false;
  }

  public clearFailedLoginAttempts(identifier: string, ip: string): void {
    const key = `${identifier}:${ip}`;
    this.failedLoginAttempts.delete(key);
  }

  public isAccountLocked(identifier: string, ip: string): boolean {
    const key = `${identifier}:${ip}`;
    const attempts = this.failedLoginAttempts.get(key);
    
    if (!attempts) return false;
    
    // Check if lock has expired (1 hour)
    const now = new Date();
    if (now.getTime() - attempts.lastAttempt.getTime() > 60 * 60 * 1000) {
      this.failedLoginAttempts.delete(key);
      return false;
    }

    return attempts.count >= 5;
  }

  // IP reputation checking
  public isSuspiciousIP(ip: string): boolean {
    const suspiciousCount = this.suspiciousIPs.get(ip) || 0;
    return suspiciousCount >= 10;
  }

  public getSuspiciousIPs(): string[] {
    return Array.from(this.suspiciousIPs.entries())
      .filter(([_, count]) => count >= 10)
      .map(([ip, _]) => ip);
  }

  // Security metrics
  public getSecurityMetrics(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsByRiskLevel: Record<string, number>;
    suspiciousIPs: number;
    lockedAccounts: number;
  } {
    const eventsByType: Record<string, number> = {};
    const eventsByRiskLevel: Record<string, number> = {};

    this.securityEvents.forEach(event => {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      eventsByRiskLevel[event.riskLevel] = (eventsByRiskLevel[event.riskLevel] || 0) + 1;
    });

    return {
      totalEvents: this.securityEvents.length,
      eventsByType,
      eventsByRiskLevel,
      suspiciousIPs: this.getSuspiciousIPs().length,
      lockedAccounts: Array.from(this.failedLoginAttempts.values()).filter(a => a.count >= 5).length
    };
  }

  // Generate secure random tokens
  public generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // Generate secure random passwords
  public generateSecurePassword(length: number = 16): string {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@$!%*?&';
    let password = '';
    
    // Ensure at least one character from each required type
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const specials = '@$!%*?&';
    
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += specials[Math.floor(Math.random() * specials.length)];
    
    // Fill the rest randomly
    for (let i = 4; i < length; i++) {
      password += charset[Math.floor(Math.random() * charset.length)];
    }
    
    // Shuffle the password
    return password.split('').sort(() => Math.random() - 0.5).join('');
  }

  // Clean up expired data
  public cleanup(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // Clean up expired failed login attempts
    for (const [key, attempt] of this.failedLoginAttempts.entries()) {
      if (attempt.lastAttempt < oneHourAgo) {
        this.failedLoginAttempts.delete(key);
      }
    }
    
    // Clean up old security events (keep last 24 hours for metrics)
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.securityEvents = this.securityEvents.filter(event => event.timestamp > twentyFourHoursAgo);
  }
}

export default SecurityService.getInstance();