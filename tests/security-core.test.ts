import request from 'supertest';
import app from '../src/app';
import SecurityService from '../src/services/security.service';
import { SecurityEventType, SecurityRiskLevel } from '../src/config/security.config';

describe('Security System Core Tests', () => {
  beforeEach(() => {
    // Clean up security service state before each test
    SecurityService.cleanup();
  });

  describe('Basic Security Features', () => {
    test('should provide security health endpoint', async () => {
      const response = await request(app)
        .get('/api/security/health');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBeDefined();
      expect(['healthy', 'warning', 'critical']).toContain(response.body.data.status);
      expect(response.body.data.metrics).toBeDefined();
    }, 10000);

    test('should validate password strength', async () => {
      const response = await request(app)
        .post('/api/security/validate-password')
        .send({ password: 'StrongP@ssw0rd123' });

      expect(response.status).toBe(200);
      expect(response.body.data.isValid).toBe(true);
      expect(response.body.data.errors.length).toBe(0);
    }, 10000);

    test('should reject weak passwords', async () => {
      const response = await request(app)
        .post('/api/security/validate-password')
        .send({ password: 'weak' });

      expect(response.status).toBe(200);
      expect(response.body.data.isValid).toBe(false);
      expect(response.body.data.errors.length).toBeGreaterThan(0);
    }, 10000);

    test('should generate secure tokens', async () => {
      const response = await request(app)
        .post('/api/security/generate-token')
        .send({ length: 32 });

      expect(response.status).toBe(200);
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.token.length).toBe(64); // hex encoded
    }, 10000);

    test('should return security metrics', async () => {
      // Generate a security event first
      SecurityService.logSecurityEvent({
        type: SecurityEventType.LOGIN_SUCCESS,
        riskLevel: SecurityRiskLevel.LOW,
        ip: '127.0.0.1',
        details: { test: true }
      });

      const response = await request(app)
        .get('/api/security/metrics');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.totalEvents).toBeGreaterThan(0);
    }, 10000);
  });

  describe('Security Headers', () => {
    test('should include basic security headers', async () => {
      const response = await request(app)
        .get('/health');

      // Check for important security headers
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    }, 10000);

    test('should include CSP headers', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    }, 10000);
  });

  describe('Security Service', () => {
    test('should track failed login attempts', async () => {
      const identifier = 'test@example.com';
      const ip = '192.168.1.100';

      // Should not be locked initially
      expect(SecurityService.isAccountLocked(identifier, ip)).toBe(false);

      // Record multiple failed attempts
      for (let i = 0; i < 6; i++) {
        SecurityService.recordFailedLogin(identifier, ip);
      }

      // Should be locked after 5 attempts
      expect(SecurityService.isAccountLocked(identifier, ip)).toBe(true);
    }, 10000);

    test('should clear failed login attempts', async () => {
      const identifier = 'test2@example.com';
      const ip = '192.168.1.101';

      // Create failed attempts
      for (let i = 0; i < 3; i++) {
        SecurityService.recordFailedLogin(identifier, ip);
      }

      // Clear attempts
      SecurityService.clearFailedLoginAttempts(identifier, ip);

      // Should not be locked
      expect(SecurityService.isAccountLocked(identifier, ip)).toBe(false);
    }, 10000);

    test('should log security events', async () => {
      const initialMetrics = SecurityService.getSecurityMetrics();
      const initialCount = initialMetrics.totalEvents;

      SecurityService.logSecurityEvent({
        type: SecurityEventType.LOGIN_SUCCESS,
        riskLevel: SecurityRiskLevel.LOW,
        ip: '127.0.0.1',
        details: { userId: 'test123' }
      });

      const newMetrics = SecurityService.getSecurityMetrics();
      expect(newMetrics.totalEvents).toBe(initialCount + 1);
    }, 10000);

    test('should validate password strength correctly', async () => {
      const weakPassword = 'password123';
      const strongPassword = 'StrongP@ssw0rd123!';

      const weakValidation = SecurityService.validatePasswordStrength(weakPassword);
      expect(weakValidation.isValid).toBe(false);
      expect(weakValidation.errors.length).toBeGreaterThan(0);

      const strongValidation = SecurityService.validatePasswordStrength(strongPassword);
      expect(strongValidation.isValid).toBe(true);
      expect(strongValidation.errors.length).toBe(0);
    }, 10000);

    test('should generate secure passwords', async () => {
      const password = SecurityService.generateSecurePassword(16);
      expect(password.length).toBe(16);

      const validation = SecurityService.validatePasswordStrength(password);
      expect(validation.isValid).toBe(true);
    }, 10000);

    test('should generate secure tokens', async () => {
      const token = SecurityService.generateSecureToken(32);
      expect(token.length).toBe(64); // hex encoded
      expect(/^[a-f0-9]+$/i.test(token)).toBe(true);
    }, 10000);
  });

  describe('API Endpoints', () => {
    test('should handle security cleanup', async () => {
      const response = await request(app)
        .post('/api/security/cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Security data cleanup completed');
    }, 10000);

    test('should return suspicious IPs', async () => {
      const response = await request(app)
        .get('/api/security/suspicious-ips');

      expect(response.status).toBe(200);
      expect(response.body.data.count).toBeDefined();
      expect(response.body.data.ips).toBeDefined();
      expect(Array.isArray(response.body.data.ips)).toBe(true);
    }, 10000);

    test('should check if IP is suspicious', async () => {
      const response = await request(app)
        .get('/api/security/check-ip/127.0.0.1');

      expect(response.status).toBe(200);
      expect(response.body.data.ip).toBe('127.0.0.1');
      expect(typeof response.body.data.suspicious).toBe('boolean');
    }, 10000);

    test('should clear failed login attempts through API', async () => {
      const response = await request(app)
        .post('/api/security/clear-failed-logins')
        .send({
          identifier: 'test@example.com',
          ip: '192.168.1.100'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    }, 10000);
  });

  describe('Error Handling', () => {
    test('should validate required fields for password validation', async () => {
      const response = await request(app)
        .post('/api/security/validate-password')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Password required');
    }, 10000);

    test('should validate token length limits', async () => {
      // Test minimum length
      let response = await request(app)
        .post('/api/security/generate-token')
        .send({ length: 8 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token length');

      // Test maximum length
      response = await request(app)
        .post('/api/security/generate-token')
        .send({ length: 256 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token length');
    }, 10000);

    test('should validate required fields for clearing failed logins', async () => {
      const response = await request(app)
        .post('/api/security/clear-failed-logins')
        .send({ identifier: 'test@example.com' }); // missing ip

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Missing required fields');
    }, 10000);
  });
});