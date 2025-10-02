import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.middleware';
import { checkMFARequirement, requireMFAVerification } from './mfa.middleware';

/**
 * Enhanced authentication middleware that includes MFA checking
 * Use this for sensitive operations that require both authentication and MFA
 */
export const requireAuthWithMFA = [
  requireAuth,
  checkMFARequirement,
  requireMFAVerification,
];

/**
 * Middleware specifically for sensitive lawyer operations
 * Requires lawyer role + MFA verification for sensitive actions
 */
export const requireLawyerWithMFA = [
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'LAWYER') {
      return res.status(403).json({ message: 'Lawyer access required' });
    }
    next();
  },
  checkMFARequirement,
  requireMFAVerification,
];

/**
 * Middleware for admin operations with MFA
 */
export const requireAdminWithMFA = [
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'READ') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  },
  checkMFARequirement,
  requireMFAVerification,
];

/**
 * Middleware for operations that should check MFA but not block if not configured
 * Useful for gradual MFA rollout
 */
export const requireAuthWithOptionalMFA = [
  requireAuth,
  checkMFARequirement,
  // No requireMFAVerification - just sets req.mfaRequired for informational use
];

export default {
  requireAuthWithMFA,
  requireLawyerWithMFA,
  requireAdminWithMFA,
  requireAuthWithOptionalMFA,
};