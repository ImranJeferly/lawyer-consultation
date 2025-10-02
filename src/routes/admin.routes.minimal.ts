import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { UserRole, VerificationStatus } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to ensure admin access
const requireAdmin = (req: any, res: any, next: any) => {
  if (!req.user || req.user.role !== UserRole.ADMIN) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * GET /api/admin/lawyers
 * Get all lawyers with pagination - SIMPLIFIED
 */
router.get('/lawyers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const lawyers = await prisma.user.findMany({
      where: { role: UserRole.LAWYER },
      include: {
        lawyerProfile: true
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' }
    });

    const total = await prisma.user.count({
      where: { role: UserRole.LAWYER }
    });

    res.json({
      lawyers: lawyers.map(lawyer => ({
        id: lawyer.id,
        firstName: lawyer.firstName,
        lastName: lawyer.lastName,
        email: lawyer.email,
        verificationStatus: lawyer.lawyerProfile?.verificationStatus || VerificationStatus.PENDING,
        createdAt: lawyer.createdAt,
        profile: lawyer.lawyerProfile
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get lawyers error:', error);
    res.status(500).json({ error: 'Failed to get lawyers' });
  }
});

/**
 * PUT /api/admin/lawyers/:id/verification-status
 * Update lawyer verification status - SIMPLIFIED
 */
router.put('/lawyers/:id/verification-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!Object.values(VerificationStatus).includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    const lawyerProfile = await prisma.lawyerProfile.findUnique({
      where: { userId: id }
    });

    if (!lawyerProfile) {
      return res.status(404).json({ error: 'Lawyer profile not found' });
    }

    const updatedProfile = await prisma.lawyerProfile.update({
      where: { id: lawyerProfile.id },
      data: {
        verificationStatus: status,
        verificationNotes: notes,
        verificationCompletedAt: status === VerificationStatus.VERIFIED ? new Date() : null,
        updatedAt: new Date()
      }
    });

    res.json({
      message: 'Verification status updated successfully',
      lawyerProfile: updatedProfile
    });
  } catch (error) {
    console.error('Update verification status error:', error);
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

/**
 * GET /api/admin/dashboard/stats
 * Get dashboard statistics - SIMPLIFIED
 */
router.get('/dashboard/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const totalLawyers = await prisma.user.count({
      where: { role: UserRole.LAWYER }
    });

    const verifiedLawyers = await prisma.lawyerProfile.count({
      where: { verificationStatus: VerificationStatus.VERIFIED }
    });

    const pendingLawyers = await prisma.lawyerProfile.count({
      where: { verificationStatus: VerificationStatus.PENDING }
    });

    const rejectedLawyers = await prisma.lawyerProfile.count({
      where: { verificationStatus: VerificationStatus.REJECTED }
    });

    res.json({
      lawyers: {
        total: totalLawyers,
        verified: verifiedLawyers,
        pending: pendingLawyers,
        rejected: rejectedLawyers
      },
      verification: {
        pendingReview: pendingLawyers,
        verified: verifiedLawyers,
        rejected: rejectedLawyers
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

export default router;