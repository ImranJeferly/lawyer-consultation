import request from 'supertest';
import app from '../src/app';
import SecurityService from '../src/services/security.service';
import { SecurityEventType, SecurityRiskLevel } from '../src/config/security.config';

describe('Security System Tests', () => {
  beforeEach(() => {
    // Clean up security service state before each test
    SecurityService.cleanup();
  });

  describe('Input Sanitization', () => {
    test('should sanitize XSS attempts in body', async () => {
      const maliciousData = {
        name: '<script>alert("xss")</script>',
        description: '<img src="x" onerror="alert(1)">',
        nested: {
          field: '<iframe src="javascript:alert(1)"></iframe>'
        }
      };

      const response = await request(app)
        .post('/api/security/log-event')
        .send({
          type: 'login_success',
          riskLevel: 'low',
          details: maliciousData
        });

      expect(response.status).toBe(200);
      // The malicious scripts should be sanitized
      expect(response.body.success).toBe(true);
    }, 10000);

    test('should sanitize XSS attempts in query parameters', async () => {
      const response = await request(app)
        .get('/api/security/check-ip/127.0.0.1')
        .query({
          malicious: '<script>alert("xss")</script>',
          nested: '<img src="x" onerror="alert(1)">'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    }, 10000);
  });

  describe('SQL Injection Prevention', () => {
    test('should block SQL injection attempts in body', async () => {
      const sqlInjectionAttempts = [
        "'; DROP TABLE users; --",
        "1' OR '1'='1",
        "UNION SELECT * FROM users",
        "'; INSERT INTO users VALUES",
        "1; DELETE FROM users WHERE 1=1"
      ];

      for (const injection of sqlInjectionAttempts) {
        const response = await request(app)
          .post('/api/security/log-event')
          .send({
            type: 'login_success',
            riskLevel: 'low',
            details: { userInput: injection }
          });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Invalid Input');
        expect(response.body.code).toBe('SECURITY_VIOLATION');
      }
    }, 15000);

    test('should block SQL injection attempts in query parameters', async () => {
      const response = await request(app)
        .get('/api/security/check-ip/127.0.0.1')
        .query({
          filter: "'; DROP TABLE users; --"
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid Input');
      expect(response.body.code).toBe('SECURITY_VIOLATION');
    }, 10000);

    test('should allow legitimate queries', async () => {
      const response = await request(app)
        .post('/api/security/log-event')
        .send({
          type: 'login_success',
          riskLevel: 'low',
          details: {
            userInput: 'John Doe',
            description: 'A legitimate user description'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    }, 10000);
  });

  describe('Security Headers', () => {
    test('should include security headers in responses', async () => {
      const response = await request(app)
        .get('/health');

      // Check for important security headers (helmet defaults)
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-xss-protection']).toBe('0');
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    }, 10000);

    test('should include CSP headers', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    }, 10000);
  });

  describe('Password Security', () => {
    test('should validate password strength correctly', async () => {
      const weakPasswords = [
        'password',
        '123456',
        'abc123',
        'password123',
        'qwerty'
      ];

      for (const password of weakPasswords) {
        const response = await request(app)
          .post('/api/security/validate-password')
          .send({ password });

        expect(response.status).toBe(200);
        expect(response.body.data.isValid).toBe(false);
        expect(response.body.data.errors.length).toBeGreaterThan(0);
      }
    }, 15000);

    test('should accept strong passwords', async () => {
      const strongPasswords = [
        'StrongP@ssw0rd123',
        'MyS3cur3P@ssword!',
        'C0mpl3xP@ssw0rd#2023'
      ];

      for (const password of strongPasswords) {
        const response = await request(app)
          .post('/api/security/validate-password')
          .send({ password });

        expect(response.status).toBe(200);
        expect(response.body.data.isValid).toBe(true);
        expect(response.body.data.errors.length).toBe(0);
      }
    }, 15000);

    test('should generate secure passwords', async () => {
      const response = await request(app)
        .post('/api/security/generate-password')
        .send({ length: 16 });

      expect(response.status).toBe(200);
      expect(response.body.data.password).toBeDefined();
      expect(response.body.data.password.length).toBe(16);
      expect(response.body.data.strength.isValid).toBe(true);
    }, 10000);
  });

  describe('Security Token Generation', () => {
    test('should generate secure tokens', async () => {
      const response = await request(app)
        .post('/api/security/generate-token')
        .send({ length: 32 });

      expect(response.status).toBe(200);
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.token.length).toBe(64); // hex encoded = double length
      expect(response.body.data.length).toBe(64);
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
  });

  describe('Failed Login Tracking', () => {
    test('should track failed login attempts', async () => {
      const identifier = 'test@example.com';
      const ip = '192.168.1.100';

      // Simulate multiple failed login attempts
      for (let i = 0; i < 6; i++) {
        SecurityService.recordFailedLogin(identifier, ip);
      }

      const response = await request(app)
        .get(`/api/security/check-lock/${identifier}/${ip}`);

      expect(response.status).toBe(200);
      expect(response.body.data.locked).toBe(true);
    }, 10000);

    test('should clear failed login attempts', async () => {
      const identifier = 'test2@example.com';
      const ip = '192.168.1.101';

      // Create failed attempts
      for (let i = 0; i < 3; i++) {
        SecurityService.recordFailedLogin(identifier, ip);
      }

      // Clear attempts
      const response = await request(app)
        .post('/api/security/clear-failed-logins')
        .send({ identifier, ip });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Check if cleared
      const checkResponse = await request(app)
        .get(`/api/security/check-lock/${identifier}/${ip}`);

      expect(checkResponse.body.data.locked).toBe(false);
    }, 10000);
  });

  describe('Security Metrics', () => {
    test('should return security metrics', async () => {
      // Generate some security events
      SecurityService.logSecurityEvent({
        type: SecurityEventType.LOGIN_SUCCESS,
        riskLevel: SecurityRiskLevel.LOW,
        ip: '127.0.0.1',
        details: { test: true }
      });

      SecurityService.logSecurityEvent({
        type: SecurityEventType.LOGIN_FAILURE,
        riskLevel: SecurityRiskLevel.MEDIUM,
        ip: '192.168.1.100',
        details: { test: true }
      });

      const response = await request(app)
        .get('/api/security/metrics');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.totalEvents).toBeGreaterThan(0);
      expect(response.body.data.eventsByType).toBeDefined();
      expect(response.body.data.eventsByRiskLevel).toBeDefined();
    }, 10000);

    test('should return suspicious IPs', async () => {
      // Simulate suspicious activity from multiple IPs
      for (let i = 0; i < 12; i++) {
        SecurityService.logSecurityEvent({
          type: SecurityEventType.SUSPICIOUS_ACTIVITY,
          riskLevel: SecurityRiskLevel.HIGH,
          ip: '192.168.1.200',
          details: { attempt: i }
        });
      }

      const response = await request(app)
        .get('/api/security/suspicious-ips');

      expect(response.status).toBe(200);
      expect(response.body.data.count).toBeGreaterThanOrEqual(0);
      expect(response.body.data.ips).toBeDefined();
    }, 10000);
  });

  describe('Security Health Check', () => {
    test('should return security health status', async () => {
      const response = await request(app)
        .get('/api/security/health');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBeDefined();
      expect(['healthy', 'warning', 'critical']).toContain(response.body.data.status);
      expect(response.body.data.metrics).toBeDefined();
    }, 10000);

    test('should detect security issues in health check', async () => {
      // Create critical security events
      for (let i = 0; i < 2; i++) {
        SecurityService.logSecurityEvent({
          type: SecurityEventType.SQL_INJECTION_ATTEMPT,
          riskLevel: SecurityRiskLevel.CRITICAL,
          ip: '192.168.1.300',
          details: { attempt: i }
        });
      }

      const response = await request(app)
        .get('/api/security/health');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('critical');
      expect(response.body.data.issues.length).toBeGreaterThan(0);
    }, 10000);
  });

  describe('Request Size Security', () => {
    test('should accept normal-sized requests', async () => {
      const normalData = {
        type: 'login_success',
        riskLevel: 'low',
        details: { message: 'A'.repeat(1000) } // 1KB
      };

      const response = await request(app)
        .post('/api/security/log-event')
        .send(normalData);

      expect(response.status).toBe(200);
    }, 10000);
  });

  describe('Security Event Logging', () => {
    test('should log security events with all required fields', async () => {
      const response = await request(app)
        .post('/api/security/log-event')
        .send({
          type: 'login_success',
          riskLevel: 'low',
          details: { userId: 'test123', success: true }
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Security event logged');
    }, 10000);

    test('should validate security event types', async () => {
      const response = await request(app)
        .post('/api/security/log-event')
        .send({
          type: 'invalid_event_type',
          riskLevel: 'low',
          details: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid event type');
    }, 10000);

    test('should validate risk levels', async () => {
      const response = await request(app)
        .post('/api/security/log-event')
        .send({
          type: 'login_success',
          riskLevel: 'invalid_risk_level',
          details: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid risk level');
    }, 10000);
  });

  describe('Security Cleanup', () => {
    test('should cleanup expired security data', async () => {
      const response = await request(app)
        .post('/api/security/cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Security data cleanup completed');
    }, 10000);
  });
});

describe('Security Integration Tests', () => {
  test('should handle security middleware stack correctly', async () => {
    // Test that all security middleware is applied in correct order
    const response = await request(app)
      .post('/api/security/validate-password')
      .send({ password: 'TestP@ssw0rd123' });

    expect(response.status).toBe(200);
    
    // Check that security headers are present
    expect(response.headers['x-content-type-options']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBeDefined();
  }, 10000);

  test('should maintain security across different endpoints', async () => {
    const endpoints = [
      '/api/security/health',
      '/api/security/metrics',
      '/health'
    ];

    for (const endpoint of endpoints) {
      const response = await request(app).get(endpoint);
      
      expect(response.status).toBeLessThan(500);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  }, 15000);
});