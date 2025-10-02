import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import prisma from '../config/database';
import verificationWorkflowService from '../services/verificationWorkflow.service';
import documentUploadService from '../services/documentUpload.service';
import { VerificationStatus, DocumentType, UserRole } from '@prisma/client';

const router = express.Router();

// Rate limiting for admin operations
const adminLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requests per window for admins
  message: 'Too many admin requests from this IP'
});

router.use(adminLimit);

// Require admin role for all admin routes
router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

/**
 * GET /api/admin/verification/pending
 * Get lawyers pending verification review
 */
router.get('/verification/pending', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Build filter conditions
    const whereConditions: any = {};
    if (status && Object.values(VerificationStatus).includes(status as VerificationStatus)) {
      whereConditions.verificationStatus = status;
    } else {
      // Default to pending review statuses
      whereConditions.verificationStatus = {
        in: [VerificationStatus.UNDER_REVIEW, VerificationStatus.DOCUMENTS_REQUIRED]
      };
    }

    const [lawyers, totalCount] = await Promise.all([
      prisma.lawyerProfile.findMany({
        where: whereConditions,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              createdAt: true
            }
          },
          verificationDocuments: {
            orderBy: { uploadedAt: 'desc' }
          }
        },
        orderBy: [
          { verificationSubmittedAt: 'asc' }, // Oldest submissions first
          { createdAt: 'asc' }
        ],
        skip,
        take: Number(limit)
      }),
      prisma.lawyerProfile.count({ where: whereConditions })
    ]);

    // Add verification progress to each lawyer
    const lawyersWithProgress = lawyers.map(lawyer => {
      const progress = verificationWorkflowService.getVerificationProgress(lawyer);
      const nextSteps = verificationWorkflowService.getNextSteps(lawyer);
      const statusInfo = verificationWorkflowService.getStatusDisplayInfo(lawyer.verificationStatus);

      return {
        ...lawyer,
        verificationProgress: progress,
        nextSteps,
        statusInfo,
        waitingTime: lawyer.verificationSubmittedAt
          ? Math.floor((Date.now() - lawyer.verificationSubmittedAt.getTime()) / (1000 * 60 * 60 * 24))
          : null
      };
    });

    res.json({
      lawyers: lawyersWithProgress,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)),
        totalCount,
        hasNext: skip + Number(limit) < totalCount,
        hasPrev: Number(page) > 1
      }
    });
  } catch (error) {
    console.error('Get pending verification error:', error);
    res.status(500).json({ error: 'Failed to get pending verifications' });
  }
});

/**
 * GET /api/admin/verification/lawyer/:lawyerId
 * Get detailed lawyer verification information
 */
router.get('/verification/lawyer/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;

    const lawyer = await prisma.lawyerProfile.findUnique({
      where: { id: lawyerId },
      include: {
        user: true,
        verificationDocuments: {
          orderBy: { uploadedAt: 'desc' }
        }
      }
    });

    if (!lawyer) {
      return res.status(404).json({ error: 'Lawyer not found' });
    }

    const progress = verificationWorkflowService.getVerificationProgress(lawyer);
    const nextSteps = verificationWorkflowService.getNextSteps(lawyer);
    const statusInfo = verificationWorkflowService.getStatusDisplayInfo(lawyer.verificationStatus);
    const availableTransitions = verificationWorkflowService.getAvailableTransitions(lawyer.verificationStatus);

    // Get document requirements
    const documentRequirements = Object.values(DocumentType).map(docType => {
      const existingDoc = lawyer.verificationDocuments.find(doc => doc.documentType === docType);
      const requirements = documentUploadService.getUploadRequirements(docType as any); // Cast to handle type mismatch

      return {
        documentType: docType,
        uploaded: !!existingDoc,
        document: existingDoc || null,
        requirements
      };
    });

    res.json({
      lawyer: {
        ...lawyer,
        verificationProgress: progress,
        nextSteps,
        statusInfo,
        availableActions: availableTransitions.map(t => ({
          action: t.to,
          label: statusInfo.label
        })),
        documentRequirements,
        waitingTime: lawyer.verificationSubmittedAt
          ? Math.floor((Date.now() - lawyer.verificationSubmittedAt.getTime()) / (1000 * 60 * 60 * 24))
          : null
      }
    });
  } catch (error) {
    console.error('Get lawyer verification details error:', error);
    res.status(500).json({ error: 'Failed to get lawyer details' });
  }
});

/**
 * POST /api/admin/verification/approve/:lawyerId
 * Approve lawyer verification
 */
router.post('/verification/approve/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;
    const adminId = req.user?.id;
    const { notes } = req.body;

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerId,
      VerificationStatus.VERIFIED,
      adminId,
      notes || 'Approved by admin'
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message,
        requiredActions: transitionResult.requiredActions
      });
    }

    // Log admin action
    console.log(`Admin ${adminId} approved lawyer ${lawyerId}`);

    res.json({
      message: 'Lawyer verification approved successfully',
      newStatus: transitionResult.newStatus
    });
  } catch (error) {
    console.error('Approve verification error:', error);
    res.status(500).json({ error: 'Failed to approve verification' });
  }
});

/**
 * POST /api/admin/verification/reject/:lawyerId
 * Reject lawyer verification
 */
router.post('/verification/reject/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;
    const adminId = req.user?.id;
    const { notes, requiredActions } = req.body;

    if (!notes) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const rejectionNotes = `${notes}${requiredActions ? `\n\nRequired actions: ${requiredActions.join(', ')}` : ''}`;

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerId,
      VerificationStatus.REJECTED,
      adminId,
      rejectionNotes
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message
      });
    }

    // Log admin action
    console.log(`Admin ${adminId} rejected lawyer ${lawyerId}: ${notes}`);

    res.json({
      message: 'Lawyer verification rejected',
      newStatus: transitionResult.newStatus,
      rejectionReason: notes
    });
  } catch (error) {
    console.error('Reject verification error:', error);
    res.status(500).json({ error: 'Failed to reject verification' });
  }
});

/**
 * POST /api/admin/verification/request-documents/:lawyerId
 * Request additional documents from lawyer
 */
router.post('/verification/request-documents/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;
    const adminId = req.user?.id;
    const { notes, requiredDocuments } = req.body;

    const requestNotes = `${notes || 'Additional documents required'}${
      requiredDocuments ? `\n\nRequired documents: ${requiredDocuments.join(', ')}` : ''
    }`;

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerId,
      VerificationStatus.DOCUMENTS_REQUIRED,
      adminId,
      requestNotes
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message
      });
    }

    // Log admin action
    console.log(`Admin ${adminId} requested documents from lawyer ${lawyerId}`);

    res.json({
      message: 'Document request sent to lawyer',
      newStatus: transitionResult.newStatus
    });
  } catch (error) {
    console.error('Request documents error:', error);
    res.status(500).json({ error: 'Failed to request documents' });
  }
});

/**
 * POST /api/admin/verification/suspend/:lawyerId
 * Suspend verified lawyer
 */
router.post('/verification/suspend/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;
    const adminId = req.user?.id;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Suspension reason is required' });
    }

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerId,
      VerificationStatus.SUSPENDED,
      adminId,
      `Suspended: ${reason}`
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message
      });
    }

    // Log admin action
    console.log(`Admin ${adminId} suspended lawyer ${lawyerId}: ${reason}`);

    res.json({
      message: 'Lawyer suspended successfully',
      newStatus: transitionResult.newStatus,
      suspensionReason: reason
    });
  } catch (error) {
    console.error('Suspend lawyer error:', error);
    res.status(500).json({ error: 'Failed to suspend lawyer' });
  }
});

/**
 * POST /api/admin/verification/reinstate/:lawyerId
 * Reinstate suspended lawyer
 */
router.post('/verification/reinstate/:lawyerId', async (req, res) => {
  try {
    const { lawyerId } = req.params;
    const adminId = req.user?.id;
    const { notes } = req.body;

    const transitionResult = await verificationWorkflowService.transitionStatus(
      lawyerId,
      VerificationStatus.UNDER_REVIEW,
      adminId,
      notes || 'Reinstated for review'
    );

    if (!transitionResult.success) {
      return res.status(400).json({
        error: transitionResult.message
      });
    }

    // Log admin action
    console.log(`Admin ${adminId} reinstated lawyer ${lawyerId}`);

    res.json({
      message: 'Lawyer reinstated for review',
      newStatus: transitionResult.newStatus
    });
  } catch (error) {
    console.error('Reinstate lawyer error:', error);
    res.status(500).json({ error: 'Failed to reinstate lawyer' });
  }
});

/**
 * GET /api/admin/verification/documents/:documentId
 * Download verification document for review
 */
router.get('/verification/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const adminId = req.user?.id;

    const downloadResult = await documentUploadService.downloadDocument(documentId, adminId || '');

    if (!downloadResult.success) {
      return res.status(400).json({ error: downloadResult.error });
    }

    res.setHeader('Content-Type', downloadResult.mimeType!);
    res.setHeader('Content-Disposition', `inline; filename="${downloadResult.fileName}"`);
    res.send(downloadResult.fileBuffer);
  } catch (error) {
    console.error('Download document error:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

/**
 * PUT /api/admin/verification/documents/:documentId/status
 * Update document verification status
 */
router.put('/verification/documents/:documentId/status', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { status, notes } = req.body;

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updatedDocument = await prisma.verificationDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: status,
        verifierNotes: notes,
        verifiedAt: status !== 'pending' ? new Date() : null,
        verifiedBy: status !== 'pending' ? req.user?.id : null
      }
    });

    res.json({
      message: 'Document status updated successfully',
      document: updatedDocument
    });
  } catch (error) {
    console.error('Update document status error:', error);
    res.status(500).json({ error: 'Failed to update document status' });
  }
});

/**
 * GET /api/admin/verification/stats
 * Get verification statistics
 */
router.get('/verification/stats', async (req, res) => {
  try {
    const stats = await Promise.all([
      // Count by status
      prisma.lawyerProfile.groupBy({
        by: ['verificationStatus'],
        _count: true
      }),

      // Recent activity (last 30 days)
      prisma.lawyerProfile.count({
        where: {
          verificationSubmittedAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      }),

      // Average processing time for completed verifications
      prisma.lawyerProfile.findMany({
        where: {
          verificationStatus: {
            in: [VerificationStatus.VERIFIED, VerificationStatus.REJECTED]
          },
          verificationSubmittedAt: { not: null },
          verificationCompletedAt: { not: null }
        },
        select: {
          verificationSubmittedAt: true,
          verificationCompletedAt: true
        }
      }),

      // Documents by type
      prisma.verificationDocument.groupBy({
        by: ['documentType'],
        _count: true
      })
    ]);

    const [statusCounts, recentSubmissions, completedVerifications, documentCounts] = stats;

    // Calculate average processing time
    const processingTimes = completedVerifications.map(v => {
      if (v.verificationSubmittedAt && v.verificationCompletedAt) {
        return v.verificationCompletedAt.getTime() - v.verificationSubmittedAt.getTime();
      }
      return 0;
    }).filter(time => time > 0);

    const averageProcessingTime = processingTimes.length > 0
      ? Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length / (1000 * 60 * 60 * 24))
      : 0;

    res.json({
      verificationStats: {
        byStatus: statusCounts.reduce((acc, item) => {
          acc[item.verificationStatus] = item._count;
          return acc;
        }, {} as Record<string, number>),
        recentSubmissions,
        averageProcessingDays: averageProcessingTime,
        totalProcessed: completedVerifications.length
      },
      documentStats: {
        byType: documentCounts.reduce((acc, item) => {
          acc[item.documentType] = item._count;
          return acc;
        }, {} as Record<string, number>)
      },
      summary: {
        pendingReview: statusCounts.find(s => s.verificationStatus === VerificationStatus.UNDER_REVIEW)?._count || 0,
        needDocuments: statusCounts.find(s => s.verificationStatus === VerificationStatus.DOCUMENTS_REQUIRED)?._count || 0,
        verified: statusCounts.find(s => s.verificationStatus === VerificationStatus.VERIFIED)?._count || 0,
        rejected: statusCounts.find(s => s.verificationStatus === VerificationStatus.REJECTED)?._count || 0
      }
    });
  } catch (error) {
    console.error('Get verification stats error:', error);
    res.status(500).json({ error: 'Failed to get verification statistics' });
  }
});

/**
 * GET /api/admin/lawyers
 * Get all lawyers with advanced filtering
 */
router.get('/lawyers', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      practiceArea,
      verified,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Build filter conditions
    const whereConditions: any = {};

    if (search) {
      whereConditions.OR = [
        { user: { firstName: { contains: search as string, mode: 'insensitive' } } },
        { user: { lastName: { contains: search as string, mode: 'insensitive' } } },
        { user: { email: { contains: search as string, mode: 'insensitive' } } },
        { licenseNumber: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    if (status && Object.values(VerificationStatus).includes(status as VerificationStatus)) {
      whereConditions.verificationStatus = status;
    }

    if (verified !== undefined) {
      whereConditions.isVerified = verified === 'true';
    }

    if (practiceArea) {
      whereConditions.practiceAreas = {
        has: practiceArea as string
      };
    }

    const orderBy: any = {};
    if (sortBy === 'name') {
      orderBy.user = { firstName: sortOrder };
    } else if (sortBy === 'rating') {
      orderBy.rating = sortOrder;
    } else if (sortBy === 'experience') {
      orderBy.experience = sortOrder;
    } else {
      orderBy[sortBy as string] = sortOrder;
    }

    const [lawyers, totalCount] = await Promise.all([
      prisma.lawyerProfile.findMany({
        where: whereConditions,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              profileImageUrl: true,
              createdAt: true,
              lastActiveAt: true
            }
          },
          verificationDocuments: true,
          _count: {
            select: {
              appointments: true
            }
          }
        },
        orderBy,
        skip,
        take: Number(limit)
      }),
      prisma.lawyerProfile.count({ where: whereConditions })
    ]);

    res.json({
      lawyers,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalCount / Number(limit)),
        totalCount,
        hasNext: skip + Number(limit) < totalCount,
        hasPrev: Number(page) > 1
      }
    });
  } catch (error) {
    console.error('Get lawyers error:', error);
    res.status(500).json({ error: 'Failed to get lawyers' });
  }
});

export default router;