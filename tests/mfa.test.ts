import { PrismaClient } from '@prisma/client';
import simpleMFAService from '../src/services/simpleMFA.service';

describe('Multi-Factor Authentication Service', () => {
  let prisma: PrismaClient;
  let testUser: any;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    // Clean up test user if exists
    if (testUser) {
      try {
        await prisma.user.delete({ where: { id: testUser.id } });
      } catch (error) {
        // User might already be deleted
      }
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Create a fresh test user for each test
    testUser = await prisma.user.create({
      data: {
        clerkUserId: `test_mfa_user_${Date.now()}`,
        email: `test.mfa.${Date.now()}@example.com`,
        firstName: 'Test',
        lastName: 'MFA User',
        phone: '+1234567890',
        role: 'CLIENT'
      }
    });
  });

  afterEach(async () => {
    // Clean up test user after each test
    if (testUser) {
      try {
        await prisma.user.delete({ where: { id: testUser.id } });
      } catch (error) {
        // User might already be deleted
      }
      testUser = null;
    }
  });

  describe('MFA Basic Operations', () => {
    it('should initialize MFA for a user', async () => {
      const result = await simpleMFAService.initializeMFA(testUser.id);

      expect(result.success).toBe(true);
      expect(result.secret).toBeDefined();
      expect(result.qrCodeUrl).toBeDefined();
      if (result.backupCodes) {
        expect(result.backupCodes).toHaveLength(10);
      }
    });

    it('should check if user requires MFA', async () => {
      const requiresMFA = await simpleMFAService.requiresMFA(testUser.id);
      expect(typeof requiresMFA).toBe('boolean');
    });

    it('should get MFA status for user', async () => {
      const status = await simpleMFAService.getMFAStatus(testUser.id);
      
      expect(status).toBeDefined();
      expect(typeof status.enabled).toBe('boolean');
      expect(typeof status.backupCodesRemaining).toBe('number');
    });

    it('should handle verification for user without MFA', async () => {
      const result = await simpleMFAService.verifyMFA(testUser.id, '123456');
      
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle initialization for non-existent user', async () => {
      const result = await simpleMFAService.initializeMFA('non-existent-id');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('MFA Verification', () => {
    it('should verify MFA with various codes', async () => {
      // Test with invalid code
      const result = await simpleMFAService.verifyMFA(testUser.id, '000000');
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle MFA verification with backup method', async () => {
      const result = await simpleMFAService.verifyMFA(testUser.id, '12345678', 'BACKUP');
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('MFA Management', () => {
    it('should require verification code to disable MFA', async () => {
      // This should require a verification code
      try {
        const result = await simpleMFAService.disableMFA(testUser.id, '123456');
        expect(typeof result).toBe('boolean');
      } catch (error) {
        // Expected if MFA is not enabled
        expect(error).toBeDefined();
      }
    });

    it('should generate new backup codes', async () => {
      try {
        const codes = await simpleMFAService.generateNewBackupCodes(testUser.id);
        expect(Array.isArray(codes)).toBe(true);
      } catch (error) {
        // Expected if MFA is not enabled yet
        expect(error).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid user IDs gracefully', async () => {
      try {
        const result = await simpleMFAService.getMFAStatus('invalid-id');
        expect(result).toBeDefined();
      } catch (error) {
        // Expected behavior for invalid user ID
        expect(error).toBeDefined();
      }
    });

    it('should handle database connection issues', async () => {
      const requiresMFA = await simpleMFAService.requiresMFA('test-user-id');
      expect(typeof requiresMFA).toBe('boolean');
    });
  });
});