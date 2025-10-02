import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '@clerk/backend';
import prisma, { withPrismaRetry } from '../config/database';
import { clerkEnv, clerkJwtVerification } from '../config/clerk';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        sessionId: string;
      };
      user?: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
      };
      sessionClaims?: Record<string, unknown>;
    }
  }
}

const fetchUserWithRetry = async (clerkUserId: string) =>
  withPrismaRetry(
    () =>
      prisma.user.findUnique({
        where: { clerkUserId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          phone: true,
          clerkUserId: true,
        },
      }),
    2
  );

export const authenticateClerk = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const payload = await verifyToken(token, clerkJwtVerification as any);

    if (!payload || typeof payload !== 'object' || !('sub' in payload)) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    if (clerkEnv.jwtIssuer && 'iss' in payload && payload.iss !== clerkEnv.jwtIssuer) {
      return res.status(401).json({ message: 'Invalid token issuer' });
    }

    if (clerkEnv.jwtIssuer && !('iss' in payload)) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const clerkUserId = String((payload as Record<string, unknown>).sub);

    const user = await fetchUserWithRetry(clerkUserId);
    if (!user) {
      return res.status(401).json({ message: 'User not found in database' });
    }

    // Verify phone number is present (mandatory for all users)
    if (!user.phone) {
      return res.status(401).json({
        message: 'Phone verification required. Please complete phone verification to access this resource.',
        code: 'PHONE_VERIFICATION_REQUIRED'
      });
    }
    req.auth = {
      userId: clerkUserId,
      sessionId: typeof (payload as Record<string, unknown>).sid === 'string' ? (payload as Record<string, unknown>).sid as string : ''
    };
    req.user = user;
    req.sessionClaims = payload as Record<string, unknown>;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ message: 'Authentication failed' });
  }
};

export const requireLawyer = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'LAWYER') {
    return res.status(403).json({ message: 'Lawyer access required' });
  }
  next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};

// Alias for authenticateClerk
export const requireAuth = authenticateClerk;

// Generic role requirement function
export const requireRole = (role: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ message: `${role} access required` });
    }
    next();
  };
};
