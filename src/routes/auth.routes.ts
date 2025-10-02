import { Router, type RequestHandler } from 'express';
import { handleClerkWebhook } from '../controllers/webhooks/clerk.webhook';
import prisma, { withPrismaRetry } from '../config/database';
import { authenticateClerk, requireLawyer, requireAdmin } from '../middleware/auth.middleware';

type PrismaUserDelegate = Pick<
  typeof prisma.user,
  'findUnique' | 'findMany' | 'update'
>;

type PrismaLawyerProfileDelegate = Pick<
  typeof prisma.lawyerProfile,
  'create' | 'findUnique' | 'update'
>;

type AuthRouterDependencies = {
  prisma: {
    user: PrismaUserDelegate;
    lawyerProfile: PrismaLawyerProfileDelegate;
  };
  withPrismaRetry: typeof withPrismaRetry;
  authenticateClerk: RequestHandler;
  requireLawyer: RequestHandler;
  requireAdmin: RequestHandler;
};

export const createAuthRouter = ({
  prisma,
  withPrismaRetry,
  authenticateClerk,
  requireLawyer,
  requireAdmin,
}: AuthRouterDependencies) => {
  const router = Router();

  // Basic auth endpoints for testing
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          message: 'Email and password are required',
          error: 'Missing credentials',
        });
      }

      // In a real app, you would validate credentials here
      // For now, we'll return a mock response for testing
      if (email && password) {
        res.status(200).json({
          message: 'Login endpoint ready',
          note: 'This is a test endpoint. Real authentication uses Clerk.',
          email,
        });
      } else {
        res.status(401).json({ message: 'Invalid credentials' });
      }
    } catch (error) {
      res.status(500).json({ message: 'Login error', error: 'Internal server error' });
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const { email, password, firstName, lastName, role } = req.body;

      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({
          message: 'Email, password, firstName, and lastName are required',
          error: 'Missing required fields',
        });
      }

      // Validate role
      if (role && !['CLIENT', 'LAWYER'].includes(role)) {
        return res.status(400).json({
          message: 'Role must be either CLIENT or LAWYER',
          error: 'Invalid role',
        });
      }

      // In a real app, you would create the user here
      // For now, we'll return a mock response for testing
      res.status(201).json({
        message: 'Registration endpoint ready',
        note: 'This is a test endpoint. Real registration uses Clerk.',
        user: {
          email,
          firstName,
          lastName,
          role: role || 'CLIENT',
        },
      });
    } catch (error) {
      res.status(500).json({ message: 'Registration error', error: 'Internal server error' });
    }
  });

  // Webhook endpoint for Clerk user sync (no auth needed)
  router.post('/webhook', handleClerkWebhook);

  // Get current user profile (protected)
  router.get('/profile', authenticateClerk, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        include: {
          lawyerProfile: true,
        },
      });
      res.json({ user });
    } catch (error) {
      res.status(500).json({ message: 'Error fetching profile' });
    }
  });

  // Update user role (for lawyer registration)
  router.put('/role', authenticateClerk, async (req, res) => {
    try {
      const { role } = req.body;
      if (!['CLIENT', 'LAWYER'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }

      const currentUser = await withPrismaRetry(
        () =>
          prisma.user.findUnique({
            where: { id: req.user!.id },
            include: { lawyerProfile: true },
          }),
        2,
      );

      if (!currentUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      const user = await withPrismaRetry(
        () =>
          prisma.user.update({
            where: { id: req.user!.id },
            data: {
              role,
              isVerified: role === 'CLIENT' ? true : currentUser.isVerified,
            },
          }),
        2,
      );

      // Create baseline lawyer profile if switching to LAWYER role
      if (role === 'LAWYER' && !currentUser.lawyerProfile) {
        const placeholderLicense = `TEMP-${user.id.slice(0, 8)}-${Date.now()}`;

        await withPrismaRetry(
          () =>
            prisma.lawyerProfile.create({
              data: {
                userId: user.id,
                licenseNumber: placeholderLicense,
                practiceAreas: [],
                experience: 0,
                hourlyRate: 0,
                bio: '',
                isVerified: false,
              },
            }),
          2,
        );
      }

      res.json({ message: 'Role updated successfully', user });
    } catch (error) {
      console.error('Error updating role:', error);
      res.status(500).json({ message: 'Error updating role' });
    }
  });

  // Update lawyer profile (lawyer verification)
  router.put('/lawyer/profile', authenticateClerk, requireLawyer, async (req, res) => {
    try {
      const { licenseNumber, practiceAreas, experience, hourlyRate, bio } = req.body;

      const lawyerProfile = await withPrismaRetry(
        () =>
          prisma.lawyerProfile.update({
            where: { userId: req.user!.id },
            data: {
              licenseNumber,
              practiceAreas,
              experience: parseInt(experience, 10),
              hourlyRate: parseFloat(hourlyRate),
              bio,
            },
          }),
        2,
      );

      res.json({ message: 'Lawyer profile updated successfully', profile: lawyerProfile });
    } catch (error) {
      console.error('Error updating lawyer profile:', error);
      res.status(500).json({ message: 'Error updating lawyer profile' });
    }
  });

  // Submit for lawyer verification
  router.post('/lawyer/verify', authenticateClerk, requireLawyer, async (req, res) => {
    try {
      const lawyerProfile = await prisma.lawyerProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!lawyerProfile) {
        return res.status(404).json({ message: 'Lawyer profile not found' });
      }

      if (!lawyerProfile.licenseNumber || lawyerProfile.practiceAreas.length === 0) {
        return res.status(400).json({
          message: 'Please complete your profile before submitting for verification',
        });
      }

      // In a real application, you would trigger an admin review process here
      res.json({
        message: 'Verification request submitted successfully. You will be notified once reviewed.',
        profile: lawyerProfile,
      });
    } catch (error) {
      console.error('Error submitting verification:', error);
      res.status(500).json({ message: 'Error submitting verification request' });
    }
  });

  // Admin route to verify lawyers
  router.put('/admin/verify-lawyer/:userId', authenticateClerk, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { isVerified } = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: { isVerified },
      });

      const lawyerProfile = await prisma.lawyerProfile.update({
        where: { userId },
        data: { isVerified },
      });

      res.json({
        message: `Lawyer ${isVerified ? 'verified' : 'unverified'} successfully`,
        user,
        profile: lawyerProfile,
      });
    } catch (error) {
      console.error('Error verifying lawyer:', error);
      res.status(500).json({ message: 'Error updating lawyer verification status' });
    }
  });

  // Get all unverified lawyers (admin only)
  router.get('/admin/unverified-lawyers', authenticateClerk, requireAdmin, async (req, res) => {
    try {
      const unverifiedLawyers = await prisma.user.findMany({
        where: {
          role: 'LAWYER',
          isVerified: false,
        },
        include: {
          lawyerProfile: true,
        },
      });

      res.json({ lawyers: unverifiedLawyers });
    } catch (error) {
      console.error('Error fetching unverified lawyers:', error);
      res.status(500).json({ message: 'Error fetching unverified lawyers' });
    }
  });

  // Test route (keep for now)
  router.get('/test', (req, res) => {
    res.json({
      message: 'Clerk auth routes working!',
      endpoints: {
        webhook: 'POST /api/auth/webhook',
        profile: 'GET /api/auth/profile (requires Clerk token)',
        role: 'PUT /api/auth/role (requires Clerk token)',
        'lawyer-profile': 'PUT /api/auth/lawyer/profile (requires lawyer token)',
        'lawyer-verify': 'POST /api/auth/lawyer/verify (requires lawyer token)',
        'admin-verify': 'PUT /api/auth/admin/verify-lawyer/:userId (requires admin token)',
        'admin-unverified': 'GET /api/auth/admin/unverified-lawyers (requires admin token)',
      },
    });
  });
  return router;
};

const router = createAuthRouter({
  prisma,
  withPrismaRetry,
  authenticateClerk,
  requireLawyer,
  requireAdmin,
});

export type { AuthRouterDependencies };

export default router;
