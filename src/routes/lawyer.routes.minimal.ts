import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import { UserRole, VerificationStatus } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/lawyers/profile
 * Get lawyer's own profile - SIMPLIFIED
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const lawyerProfile = await prisma.lawyerProfile.findUnique({
      where: { userId: userId }
    });

    res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      bio: user.bio,
      profileImageUrl: user.profileImageUrl,
      lawyerProfile: lawyerProfile,
      verification: {
        current: lawyerProfile?.verificationStatus || VerificationStatus.PENDING,
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * POST /api/lawyers/verification/submit
 * Submit profile for verification - SIMPLIFIED
 */
router.post('/verification/submit', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const lawyerProfile = await prisma.lawyerProfile.findUnique({
      where: { userId: userId }
    });

    if (!lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    // Simplified verification: just set to verified if pending
    const currentStatus = lawyerProfile.verificationStatus;
    
    if (currentStatus === VerificationStatus.PENDING) {
      const updatedProfile = await prisma.lawyerProfile.update({
        where: { id: lawyerProfile.id },
        data: { 
          verificationStatus: VerificationStatus.VERIFIED,
          verificationSubmittedAt: new Date()
        }
      });

      res.json({
        message: 'Profile submitted for verification successfully',
        newStatus: updatedProfile.verificationStatus
      });
    } else {
      return res.status(400).json({
        error: `Cannot submit from current status: ${currentStatus}`
      });
    }
  } catch (error) {
    console.error('Submit verification error:', error);
    res.status(500).json({ error: 'Failed to submit for verification' });
  }
});

/**
 * GET /api/lawyers/verification/status
 * Get verification status and progress - SIMPLIFIED
 */
router.get('/verification/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== UserRole.LAWYER) {
      return res.status(403).json({ error: 'Access denied. Lawyer role required.' });
    }

    const lawyerProfile = await prisma.lawyerProfile.findUnique({
      where: { userId: userId }
    });

    if (!lawyerProfile) {
      return res.status(400).json({ error: 'Lawyer profile not found' });
    }

    res.json({
      currentStatus: lawyerProfile.verificationStatus,
      canReceiveAppointments: lawyerProfile.verificationStatus === 'VERIFIED',
      verificationNotes: lawyerProfile.verificationNotes,
      createdAt: lawyerProfile.verificationSubmittedAt,
      completedAt: lawyerProfile.verificationCompletedAt
    });
  } catch (error) {
    console.error('Verification status error:', error);
    res.status(500).json({ error: 'Failed to get verification status' });
  }
});

export default router;