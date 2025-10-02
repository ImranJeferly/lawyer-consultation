import express from 'express';
import {
  UserRole,
  VerificationStatus,
  VerificationDocumentType,
  NotificationType,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority
} from '@prisma/client';
import { requireAuth } from '../middleware/auth.middleware';
import prisma from '../config/database';
import notificationService from '../services/notification.service';

const router = express.Router();

const REQUIRED_DOCUMENT_TYPES: VerificationDocumentType[] = [
  VerificationDocumentType.BAR_LICENSE,
  VerificationDocumentType.STATE_ID
];

type VerificationDocumentWithMeta = {
  id: string;
  documentType: VerificationDocumentType;
  fileName: string;
  fileSize: number;
  uploadedAt: Date;
  verificationStatus: string;
  verifierNotes: string | null;
  verifiedAt: Date | null;
};

type LawyerProfileForAdmin = {
  id: string;
  verificationStatus: VerificationStatus;
  verificationSubmittedAt: Date | null;
  verificationCompletedAt: Date | null;
  verificationNotes: string | null;
  verificationDocuments?: VerificationDocumentWithMeta[];
};

const buildAdminVerificationSummary = (profile?: LawyerProfileForAdmin | null) => {
  if (!profile) {
    return null;
  }

  const documents: VerificationDocumentWithMeta[] = profile.verificationDocuments ?? [];
  const documentTypesPresent = new Set(documents.map((document) => document.documentType));
  const missingDocuments = REQUIRED_DOCUMENT_TYPES.filter((type) => !documentTypesPresent.has(type));
  const pendingDocuments = documents.filter(
    (document) => document.verificationStatus?.toLowerCase() === 'pending'
  );
  const rejectedDocuments = documents.filter(
    (document) => document.verificationStatus?.toLowerCase() === 'rejected'
  );

  return {
    status: profile.verificationStatus,
    submittedAt: profile.verificationSubmittedAt,
    completedAt: profile.verificationCompletedAt,
    notes: profile.verificationNotes,
    requiredDocuments: REQUIRED_DOCUMENT_TYPES,
    missingDocuments,
    pendingDocuments: pendingDocuments.map((document) => document.documentType),
    rejectedDocuments: rejectedDocuments.map((document) => document.documentType),
    totalDocuments: documents.length,
    documents: documents
      .slice()
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()),
    readyForApproval:
      missingDocuments.length === 0 &&
      pendingDocuments.length === 0 &&
      profile.verificationStatus === VerificationStatus.UNDER_REVIEW
  };
};

const DOCUMENT_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);

async function sendVerificationNotification(
  lawyerUser: { id: string; email: string; firstName: string; lastName: string },
  status: VerificationStatus,
  notes?: string | null
) {
  let title = 'Verification update';
  let message = 'Your verification status has been updated.';

  switch (status) {
    case VerificationStatus.VERIFIED:
      title = 'You are verified!';
      message =
        'Congratulations! Your documents have been reviewed and your account is now fully verified. You can now accept bookings from new clients.';
      break;
    case VerificationStatus.REJECTED:
      title = 'Verification unsuccessful';
      message = notes
        ? `Your verification could not be completed. Reason: ${notes}`
        : 'Your verification could not be completed. Please review the notes from our team and try again.';
      break;
    case VerificationStatus.DOCUMENTS_REQUIRED:
      title = 'Additional documents required';
      message = notes
        ? `We need more information to verify your account. ${notes}`
        : 'We need additional documents to complete your verification. Please review the requirements and resubmit.';
      break;
    default:
      break;
  }

  try {
    await notificationService.sendNotification({
      recipientId: lawyerUser.id,
      recipientEmail: lawyerUser.email,
      recipientName: `${lawyerUser.firstName} ${lawyerUser.lastName}`.trim(),
      title,
      message,
      notificationType: NotificationType.ACCOUNT_VERIFICATION,
      category: NotificationCategory.SECURITY,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      priority: NotificationPriority.HIGH,
      metadata: {
        status,
        notes
      }
    });
  } catch (error) {
    console.error('Failed to send verification notification:', error);
  }
}

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
        lawyerProfile: {
          include: {
            verificationDocuments: true
          }
        }
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
        profile: lawyer.lawyerProfile,
        verificationSummary: buildAdminVerificationSummary(lawyer.lawyerProfile as LawyerProfileForAdmin)
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
    const { status, notes } = req.body as { status: VerificationStatus; notes?: string };

    if (!Object.values(VerificationStatus).includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    const lawyer = await prisma.user.findUnique({
      where: { id },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: true
          }
        }
      }
    });

    if (!lawyer || lawyer.role !== UserRole.LAWYER || !lawyer.lawyerProfile) {
      return res.status(404).json({ error: 'Lawyer profile not found' });
    }

    const profile = lawyer.lawyerProfile;
    const documents = profile.verificationDocuments ?? [];
    const documentTypesPresent = new Set(documents.map((document) => document.documentType));
    const missingDocuments = REQUIRED_DOCUMENT_TYPES.filter((type) => !documentTypesPresent.has(type));
    const pendingDocuments = documents.filter(
      (document) => document.verificationStatus?.toLowerCase() === 'pending'
    );
    const rejectedDocuments = documents.filter(
      (document) => document.verificationStatus?.toLowerCase() === 'rejected'
    );

    const normalizedStatus = status as VerificationStatus;

    if (normalizedStatus === VerificationStatus.VERIFIED) {
      if (profile.verificationStatus !== VerificationStatus.UNDER_REVIEW) {
        return res.status(400).json({
          error: `Cannot mark profile as verified from status ${profile.verificationStatus}`
        });
      }

      if (missingDocuments.length > 0) {
        return res.status(400).json({
          error: 'All required documents must be uploaded before verification can be approved',
          missingDocuments
        });
      }

      if (pendingDocuments.length > 0) {
        return res.status(400).json({
          error: 'Please review all documents before approving verification',
          pendingDocuments: pendingDocuments.map((document) => document.documentType)
        });
      }

      if (rejectedDocuments.length > 0) {
        return res.status(400).json({
          error: 'There are rejected documents that need attention before approval',
          rejectedDocuments: rejectedDocuments.map((document) => document.documentType)
        });
      }
    }

    const updateData: Parameters<typeof prisma.lawyerProfile.update>[0]['data'] = {
      verificationStatus: normalizedStatus,
      verificationNotes: notes ?? null,
      updatedAt: new Date()
    };

    if (normalizedStatus === VerificationStatus.VERIFIED) {
      updateData.verificationCompletedAt = new Date();
      updateData.isVerified = true;
    } else if (normalizedStatus === VerificationStatus.REJECTED) {
      updateData.verificationCompletedAt = new Date();
      updateData.isVerified = false;
    } else if (normalizedStatus === VerificationStatus.DOCUMENTS_REQUIRED) {
      updateData.verificationCompletedAt = null;
      updateData.isVerified = false;
    } else if (normalizedStatus === VerificationStatus.UNDER_REVIEW) {
      updateData.verificationCompletedAt = null;
    }

    const updatedProfile = await prisma.lawyerProfile.update({
      where: { id: profile.id },
      data: updateData,
      include: {
        verificationDocuments: true
      }
    });

    await prisma.user.update({
      where: { id: lawyer.id },
      data: {
        isVerified: normalizedStatus === VerificationStatus.VERIFIED
      }
    });

    if (normalizedStatus === VerificationStatus.VERIFIED) {
      await prisma.verificationDocument.updateMany({
        where: {
          lawyerId: profile.id,
          verificationStatus: 'pending'
        },
        data: {
          verificationStatus: 'approved',
          verifiedAt: new Date(),
          verifiedBy: req.user?.id ?? null,
          verifierNotes: notes ?? null
        }
      });
    }

    const notifyStatuses: VerificationStatus[] = [
      VerificationStatus.VERIFIED,
      VerificationStatus.REJECTED,
      VerificationStatus.DOCUMENTS_REQUIRED
    ];

    if (notifyStatuses.includes(normalizedStatus)) {
      await sendVerificationNotification(lawyer, normalizedStatus, notes);
    }

    res.json({
      message: 'Verification status updated successfully',
      lawyerProfile: updatedProfile,
      verificationSummary: buildAdminVerificationSummary(updatedProfile as LawyerProfileForAdmin)
    });
  } catch (error) {
    console.error('Update verification status error:', error);
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

/**
 * POST /api/admin/lawyers/:lawyerId/documents/:documentId/review
 * Review individual verification document
 */
router.post('/lawyers/:lawyerId/documents/:documentId/review', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { lawyerId, documentId } = req.params;
    const { status, notes } = req.body as { status: string; notes?: string };

    if (!status || !DOCUMENT_REVIEW_STATUSES.has(status.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid document status. Use approved, rejected, or pending.' });
    }

    const document = await prisma.verificationDocument.findUnique({
      where: { id: documentId },
      include: {
        lawyer: {
          include: {
            user: true,
            verificationDocuments: true
          }
        }
      }
    });

    if (!document || document.lawyer.userId !== lawyerId) {
      return res.status(404).json({ error: 'Verification document not found' });
    }

    const normalizedStatus = status.toLowerCase();

    const updatedDocument = await prisma.verificationDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: normalizedStatus,
        verifierNotes: notes ?? null,
        verifiedAt: normalizedStatus === 'approved' ? new Date() : null,
        verifiedBy: normalizedStatus === 'pending' ? null : req.user?.id ?? null
      }
    });

    let updatedProfile: LawyerProfileForAdmin | null = null;

    if (normalizedStatus === 'rejected') {
      updatedProfile = await prisma.lawyerProfile.update({
        where: { id: document.lawyer.id },
        data: {
          verificationStatus: VerificationStatus.DOCUMENTS_REQUIRED,
          verificationNotes:
            notes ??
            `Document ${document.documentType} requires resubmission`,
          verificationCompletedAt: null,
          isVerified: false
        },
        include: {
          verificationDocuments: true
        }
      });

      await prisma.user.update({
        where: { id: document.lawyer.userId },
        data: { isVerified: false }
      });

      await sendVerificationNotification(
        document.lawyer.user,
        VerificationStatus.DOCUMENTS_REQUIRED,
        notes ?? `Document ${document.documentType} requires resubmission`
      );
    } else {
      updatedProfile = await prisma.lawyerProfile.findUnique({
        where: { id: document.lawyer.id },
        include: { verificationDocuments: true }
      }) as LawyerProfileForAdmin | null;
    }

    res.json({
      message: 'Document review updated successfully',
      document: updatedDocument,
      verificationSummary: buildAdminVerificationSummary(updatedProfile)
    });
  } catch (error) {
    console.error('Review verification document error:', error);
    res.status(500).json({ error: 'Failed to update document review' });
  }
});

/**
 * GET /api/admin/lawyers/:id/verification
 * Detailed verification view for a single lawyer
 */
router.get('/lawyers/:id/verification', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const lawyer = await prisma.user.findUnique({
      where: { id },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: true
          }
        }
      }
    });

    if (!lawyer || lawyer.role !== UserRole.LAWYER || !lawyer.lawyerProfile) {
      return res.status(404).json({ error: 'Lawyer profile not found' });
    }

    res.json({
      lawyer: {
        id: lawyer.id,
        firstName: lawyer.firstName,
        lastName: lawyer.lastName,
        email: lawyer.email,
        createdAt: lawyer.createdAt,
        verificationStatus: lawyer.lawyerProfile.verificationStatus,
        verificationSummary: buildAdminVerificationSummary(lawyer.lawyerProfile as LawyerProfileForAdmin)
      }
    });
  } catch (error) {
    console.error('Get lawyer verification detail error:', error);
    res.status(500).json({ error: 'Failed to fetch lawyer verification details' });
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

/**
 * GET /api/admin/users
 * Get all users with pagination
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        lastActiveAt: true
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' }
    });

    const totalUsers = await prisma.user.count();

    res.json({
      success: true,
      data: users,
      pagination: {
        page,
        limit,
        total: totalUsers,
        pages: Math.ceil(totalUsers / limit)
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * GET /api/admin/lawyers/pending-verification
 * Get lawyers pending verification
 */
router.get('/lawyers/pending-verification', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pendingLawyers = await prisma.user.findMany({
      where: {
        role: UserRole.LAWYER,
        lawyerProfile: {
          verificationStatus: {
            in: [
              VerificationStatus.PENDING,
              VerificationStatus.UNDER_REVIEW,
              VerificationStatus.DOCUMENTS_REQUIRED
            ]
          }
        }
      },
      include: {
        lawyerProfile: {
          include: {
            verificationDocuments: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: pendingLawyers.map((lawyer) => ({
        ...lawyer,
        verificationSummary: buildAdminVerificationSummary(lawyer.lawyerProfile as LawyerProfileForAdmin)
      })),
      count: pendingLawyers.length
    });
  } catch (error) {
    console.error('Get pending lawyers error:', error);
    res.status(500).json({ error: 'Failed to get pending lawyers' });
  }
});

export default router;