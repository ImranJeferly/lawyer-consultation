import express, { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { checkMFARequirement, setMFAVerified } from '../middleware/mfa.middleware';
import simpleMFAService from '../services/simpleMFA.service';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiting for MFA operations
const mfaSetupLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 setup attempts per window
  message: 'Too many MFA setup attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const mfaVerifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 verification attempts per window
  message: 'Too many MFA verification attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply authentication to all MFA routes
router.use(requireAuth);

/**
 * GET /api/mfa/status
 * Get MFA status for the current user
 */
router.get('/status', checkMFARequirement, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = await simpleMFAService.getMFAStatus(userId);

    res.json({
      success: true,
      data: {
        enabled: status.enabled,
        backupCodesRemaining: status.backupCodesRemaining,
        lastUsed: status.lastUsed,
        requiresMFA: req.mfaRequired,
        isVerified: req.mfaVerified,
      },
    });
  } catch (error) {
    console.error('Get MFA status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get MFA status',
    });
  }
});

/**
 * POST /api/mfa/setup/initialize
 * Initialize MFA setup (generate QR code and secret)
 */
router.post('/setup/initialize', mfaSetupLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await simpleMFAService.initializeMFA(userId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: {
        qrCodeUrl: result.qrCodeUrl,
        // Don't send the secret in production for security
        // secret: result.secret, 
        message: 'Scan the QR code with your authenticator app and enter the verification code to enable MFA.',
      },
    });
  } catch (error) {
    console.error('MFA setup initialization error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initialize MFA setup',
    });
  }
});

/**
 * POST /api/mfa/setup/verify
 * Verify TOTP code and complete MFA setup
 */
router.post('/setup/verify', mfaSetupLimit, async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    const userId = req.user!.id;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Verification code is required',
      });
    }

    const result = await simpleMFAService.verifyAndEnableTOTP(userId, code);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    // Generate backup codes
    const backupCodes = await simpleMFAService.generateNewBackupCodes(userId);

    res.json({
      success: true,
      data: {
        message: result.message,
        backupCodes: backupCodes,
        warning: 'Save these backup codes in a secure location. You can use them to access your account if you lose your authenticator device.',
      },
    });
  } catch (error) {
    console.error('MFA setup verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify MFA setup',
    });
  }
});

/**
 * POST /api/mfa/verify
 * Verify MFA code for authentication
 */
router.post('/verify', mfaVerifyLimit, async (req: Request, res: Response) => {
  try {
    const { code, method = 'TOTP' } = req.body;
    const userId = req.user!.id;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Verification code is required',
      });
    }

    const result = await simpleMFAService.verifyMFA(userId, code, method);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    // Mark MFA as verified for this request
    setMFAVerified(req);

    res.json({
      success: true,
      data: {
        message: 'MFA verification successful',
        verified: true,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    console.error('MFA verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify MFA code',
    });
  }
});

/**
 * POST /api/mfa/backup-codes/generate
 * Generate new backup codes
 */
router.post('/backup-codes/generate', mfaSetupLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Verify user has MFA enabled
    const status = await simpleMFAService.getMFAStatus(userId);
    if (!status.enabled) {
      return res.status(400).json({
        success: false,
        error: 'MFA must be enabled to generate backup codes',
      });
    }

    const backupCodes = await simpleMFAService.generateNewBackupCodes(userId);

    res.json({
      success: true,
      data: {
        backupCodes,
        warning: 'These backup codes replace your previous ones. Save them in a secure location.',
        message: 'New backup codes generated successfully',
      },
    });
  } catch (error) {
    console.error('Generate backup codes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate backup codes',
    });
  }
});

/**
 * POST /api/mfa/disable
 * Disable MFA (requires verification)
 */
router.post('/disable', mfaVerifyLimit, async (req: Request, res: Response) => {
  try {
    const { code, method = 'TOTP' } = req.body;
    const userId = req.user!.id;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Verification code is required to disable MFA',
      });
    }

    const result = await simpleMFAService.disableMFA(userId, code, method);

    if (!result) {
      return res.status(400).json({
        success: false,
        error: 'Invalid verification code or MFA disable failed',
      });
    }

    res.json({
      success: true,
      data: {
        message: 'Multi-factor authentication has been disabled',
        warning: 'Your account is now less secure. Consider re-enabling MFA for better protection.',
        disabled: true,
      },
    });
  } catch (error) {
    console.error('MFA disable error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disable MFA',
    });
  }
});

/**
 * GET /api/mfa/recovery-info
 * Get recovery information (without sensitive data)
 */
router.get('/recovery-info', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = await simpleMFAService.getMFAStatus(userId);

    if (!status.enabled) {
      return res.status(400).json({
        success: false,
        error: 'MFA is not enabled',
      });
    }

    res.json({
      success: true,
      data: {
        backupCodesRemaining: status.backupCodesRemaining,
        hasBackupCodes: status.backupCodesRemaining > 0,
        lastUsed: status.lastUsed,
        recoveryOptions: [
          {
            method: 'backup_codes',
            available: status.backupCodesRemaining > 0,
            description: 'Use one of your saved backup codes',
          },
          {
            method: 'support_contact',
            available: true,
            description: 'Contact support for account recovery assistance',
          },
        ],
      },
    });
  } catch (error) {
    console.error('Get recovery info error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get recovery information',
    });
  }
});

/**
 * POST /api/mfa/test
 * Test endpoint to check MFA setup (development only)
 */
if (process.env.NODE_ENV === 'development') {
  router.post('/test', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const status = await simpleMFAService.getMFAStatus(userId);

      res.json({
        success: true,
        data: {
          userId,
          mfaStatus: status,
          userInfo: {
            id: req.user!.id,
            email: req.user!.email,
            role: req.user!.role,
          },
          requestMFA: {
            required: req.mfaRequired,
            verified: req.mfaVerified,
          },
        },
      });
    } catch (error) {
      console.error('MFA test error:', error);
      res.status(500).json({
        success: false,
        error: 'MFA test failed',
      });
    }
  });
}

export default router;