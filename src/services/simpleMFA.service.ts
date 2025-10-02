import { authenticator } from 'otplib';
import { randomBytes, createHash } from 'crypto';
import qrcode from 'qrcode';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import notificationService from './notification.service';
import { encryptData, decryptData } from '../utils/encryption';

// Configuration constants
const MFA_CONFIG = {
  TOTP: {
    window: 2,
    step: 30,
    digits: 6,
    algorithm: 'sha1',
    issuer: 'LawyerConsult',
  },
  BACKUP_CODES: {
    count: 10,
    length: 8,
  },
  RATE_LIMITING: {
    maxAttempts: 5,
    lockoutDuration: 15 * 60 * 1000, // 15 minutes
  },
};

interface MFASetupResult {
  success: boolean;
  secret?: string;
  qrCodeUrl?: string;
  backupCodes?: string[];
  error?: string;
}

interface MFAVerificationResult {
  success: boolean;
  requiresMFA?: boolean;
  message?: string;
  error?: string;
}

interface MFAStatusResult {
  enabled: boolean;
  backupCodesRemaining: number;
  lastUsed?: Date;
}

class SimpleMFAService {
  private encryptionKey: string;

  constructor() {
    this.encryptionKey = process.env.MFA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'fallback-key';
    
    // Configure TOTP library
    authenticator.options = {
      window: MFA_CONFIG.TOTP.window,
      step: MFA_CONFIG.TOTP.step,
      digits: MFA_CONFIG.TOTP.digits,
      algorithm: MFA_CONFIG.TOTP.algorithm as any,
    };
  }

  /**
   * Initialize MFA setup for a user
   */
  async initializeMFA(userId: string): Promise<MFASetupResult> {
    try {
      // Check if user already has MFA enabled
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (user.mfaEnabled) {
        return {
          success: false,
          error: 'MFA is already enabled for this user',
        };
      }

      // Generate TOTP secret
      const secret = authenticator.generateSecret();
      const encryptedSecret = await encryptData(secret, this.encryptionKey);

      // Generate QR code
      const label = `${user.firstName} ${user.lastName} (${user.email})`;
      const otpauth = authenticator.keyuri(user.email, MFA_CONFIG.TOTP.issuer, secret);
      const qrCodeUrl = await qrcode.toDataURL(otpauth);

      // Store encrypted secret temporarily (we'll confirm it when they verify)
      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaSecret: encryptedSecret,
        },
      });

      return {
        success: true,
        secret,
        qrCodeUrl,
      };
    } catch (error) {
      console.error('MFA initialization error:', error);
      return {
        success: false,
        error: 'Failed to initialize MFA',
      };
    }
  }

  /**
   * Verify TOTP code and complete MFA setup
   */
  async verifyAndEnableTOTP(userId: string, code: string): Promise<MFAVerificationResult> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user || !user.mfaSecret) {
        return {
          success: false,
          error: 'MFA setup not found. Please initialize MFA first.',
        };
      }

      // Decrypt secret
      const secret = await decryptData(user.mfaSecret, this.encryptionKey);
      
      // Verify the code
      const isValid = authenticator.check(code, secret);

      if (!isValid) {
        return {
          success: false,
          error: 'Invalid verification code',
        };
      }

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();
      const encryptedBackupCodes = await Promise.all(
        backupCodes.map(code => encryptData(code, this.encryptionKey))
      );

      // Enable MFA
      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: true,
          mfaMethod: 'TOTP',
          mfaBackupCodes: encryptedBackupCodes,
          mfaLastUsedAt: new Date(),
        },
      });

      // Send notification
      await notificationService.sendNotification({
        recipientId: userId,
        title: '🔐 Multi-Factor Authentication Enabled',
        message: 'Two-factor authentication has been successfully enabled for your account.',
        notificationType: 'SECURITY_ALERT',
        status: 'HIGH',
        channels: ['IN_APP', 'EMAIL'],
      });

      return {
        success: true,
        message: 'TOTP successfully enabled',
      };
    } catch (error) {
      console.error('TOTP verification error:', error);
      return {
        success: false,
        error: 'Failed to verify TOTP code',
      };
    }
  }

  /**
   * Verify MFA code during login or sensitive operations
   */
  async verifyMFA(userId: string, code: string, method: 'TOTP' | 'BACKUP' = 'TOTP'): Promise<MFAVerificationResult> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user || !user.mfaEnabled) {
        return {
          success: false,
          error: 'MFA not enabled for this user',
        };
      }

      let isValid = false;

      if (method === 'TOTP') {
        if (!user.mfaSecret) {
          return {
            success: false,
            error: 'TOTP not configured',
          };
        }

        const secret = await decryptData(user.mfaSecret, this.encryptionKey);
        isValid = authenticator.check(code, secret);
      } else if (method === 'BACKUP') {
        isValid = await this.verifyBackupCode(userId, code);
      }

      if (isValid) {
        // Update last used timestamp
        await prisma.user.update({
          where: { id: userId },
          data: {
            mfaLastUsedAt: new Date(),
          },
        });

        return { success: true };
      } else {
        return {
          success: false,
          error: 'Invalid verification code',
        };
      }
    } catch (error) {
      console.error('MFA verification error:', error);
      return {
        success: false,
        error: 'Failed to verify MFA code',
      };
    }
  }

  /**
   * Get MFA status for a user
   */
  async getMFAStatus(userId: string): Promise<MFAStatusResult> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new Error('User not found');
      }

      return {
        enabled: user.mfaEnabled || false,
        backupCodesRemaining: user.mfaBackupCodes?.length || 0,
        lastUsed: user.mfaLastUsedAt || undefined,
      };
    } catch (error) {
      console.error('Get MFA status error:', error);
      throw new Error('Failed to get MFA status');
    }
  }

  /**
   * Generate new backup codes
   */
  async generateNewBackupCodes(userId: string): Promise<string[]> {
    try {
      const backupCodes = this.generateBackupCodes();
      const encryptedBackupCodes = await Promise.all(
        backupCodes.map(code => encryptData(code, this.encryptionKey))
      );

      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaBackupCodes: encryptedBackupCodes,
        },
      });

      return backupCodes;
    } catch (error) {
      console.error('Generate backup codes error:', error);
      throw new Error('Failed to generate backup codes');
    }
  }

  /**
   * Disable MFA for a user (with proper verification)
   */
  async disableMFA(userId: string, verificationCode: string, method: 'TOTP' | 'BACKUP' = 'TOTP'): Promise<boolean> {
    try {
      // First verify the code
      const verification = await this.verifyMFA(userId, verificationCode, method);
      
      if (!verification.success) {
        return false;
      }

      // Disable MFA
      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: false,
          mfaMethod: 'NONE',
          mfaSecret: null,
          mfaBackupCodes: [],
        },
      });

      // Send security notification
      await notificationService.sendNotification({
        recipientId: userId,
        title: '⚠️ Multi-Factor Authentication Disabled',
        message: 'Two-factor authentication has been disabled for your account. If this was not you, please contact support immediately.',
        notificationType: 'SECURITY_ALERT',
        status: 'HIGH',
        channels: ['IN_APP', 'EMAIL'],
      });

      return true;
    } catch (error) {
      console.error('Disable MFA error:', error);
      return false;
    }
  }

  /**
   * Check if MFA is required for a user
   */
  async requiresMFA(userId: string): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { mfaEnabled: true },
      });

      return user?.mfaEnabled || false;
    } catch (error) {
      console.error('Check MFA requirement error:', error);
      return false;
    }
  }

  // Private helper methods
  
  private async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user?.mfaBackupCodes?.length) return false;

      // Check each backup code
      for (let i = 0; i < user.mfaBackupCodes.length; i++) {
        const encryptedCode = user.mfaBackupCodes[i];
        const decryptedCode = await decryptData(encryptedCode, this.encryptionKey);
        
        if (decryptedCode === code) {
          // Mark this backup code as used by removing it
          const updatedCodes = [...user.mfaBackupCodes];
          updatedCodes.splice(i, 1);
          
          await prisma.user.update({
            where: { id: userId },
            data: {
              mfaBackupCodes: updatedCodes,
            },
          });
          
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error('Backup code verification error:', error);
      return false;
    }
  }

  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < MFA_CONFIG.BACKUP_CODES.count; i++) {
      codes.push(this.generateRandomCode(MFA_CONFIG.BACKUP_CODES.length));
    }
    return codes;
  }

  private generateRandomCode(length: number): string {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}

export default new SimpleMFAService();