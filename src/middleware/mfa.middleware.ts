import { Request, Response, NextFunction } from 'express';
import simpleMFAService from '../services/simpleMFA.service';

declare global {
  namespace Express {
    interface Request {
      mfaRequired?: boolean;
      mfaVerified?: boolean;
      mfaBypassReason?: string;
    }
  }
}

/**
 * Middleware to check if MFA is required for the current user
 * This should be applied after authentication middleware
 */
export const checkMFARequirement = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Skip MFA check if user is not authenticated
    if (!req.user?.id) {
      return next();
    }

    // Check if MFA is enabled for this user
    const requiresMFA = await simpleMFAService.requiresMFA(req.user.id);
    req.mfaRequired = requiresMFA;

    // For now, we'll handle MFA verification through specific endpoints
    // In production, you might want to implement token-based MFA state tracking
    req.mfaVerified = !requiresMFA; // If MFA not required, consider it verified

    next();
  } catch (error) {
    console.error('MFA requirement check error:', error);
    req.mfaRequired = false;
    req.mfaVerified = true; // Default to allowing access on error
    next();
  }
};

/**
 * Middleware to enforce MFA verification for sensitive operations
 * Returns 403 if MFA is required but not verified
 */
export const requireMFAVerification = (req: Request, res: Response, next: NextFunction) => {
  // Check if MFA is required but not verified
  if (req.mfaRequired && !req.mfaVerified) {
    return res.status(403).json({
      error: 'Multi-factor authentication required',
      code: 'MFA_REQUIRED',
      message: 'This action requires multi-factor authentication. Please verify your identity.',
      requiresMFA: true,
    });
  }

  next();
};

/**
 * Middleware to provide MFA information without blocking
 * Used for informational purposes in login responses
 */
export const getMFAInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user?.id) {
      return next();
    }

    const status = await simpleMFAService.getMFAStatus(req.user.id);
    
    // Add MFA info to request for use in response
    req.mfaRequired = status.enabled;
    req.mfaVerified = !status.enabled; // If MFA not enabled, consider it verified

    next();
  } catch (error) {
    console.error('MFA info check error:', error);
    next();
  }
};

/**
 * Mark MFA as verified in the request (for this request only)
 */
export const setMFAVerified = (req: Request) => {
  req.mfaVerified = true;
};

/**
 * Clear MFA verification from request
 */
export const clearMFAVerification = (req: Request) => {
  req.mfaVerified = false;
};

export default {
  checkMFARequirement,
  requireMFAVerification,
  getMFAInfo,
  setMFAVerified,
  clearMFAVerification,
};