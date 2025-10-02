import express, { Request, Response } from 'express';
import Joi from 'joi';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimit } from 'express-rate-limit';
import payoutManagerService from '../services/payoutManager.service';
import prisma from '../config/database';

const router = express.Router();

// Rate limiting for payout operations
const payoutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 payout requests per windowMs
  message: {
    error: 'Too many payout requests, please try again later',
    retryAfter: '15 minutes'
  }
});

// Validation schemas
const payoutRequestSchema = Joi.object({
  requestedAmount: Joi.number().min(50).optional(),
  bankDetails: Joi.object({
    bankName: Joi.string().required(),
    accountNumber: Joi.string().required(),
    routingNumber: Joi.string().optional(),
    iban: Joi.string().optional(),
    swiftCode: Joi.string().optional()
  }).optional(),
  notes: Joi.string().max(500).optional()
});

/**
 * GET /api/payouts/earnings
 * Get lawyer's current earnings and dashboard data
 */
router.get('/earnings',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;

      // Verify user is a lawyer
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user || user.role !== 'LAWYER' || !user.lawyerProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only verified lawyers can access earnings']
        });
      }

      const lawyerId = user.lawyerProfile.id;

      // Get comprehensive earnings dashboard
      const dashboard = await payoutManagerService.getLawyerEarningsDashboard(lawyerId);

      // Get payout eligibility
      const eligibility = await payoutManagerService.checkPayoutEligibility(lawyerId);

      res.json({
        success: true,
        data: {
          ...dashboard,
          payoutEligibility: eligibility
        }
      });

    } catch (error) {
      console.error('Get earnings error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get earnings data',
        details: []
      });
    }
  }
);

/**
 * POST /api/payouts/request
 * Create a payout request for lawyer
 */
router.post('/request',
  requireAuth,
  payoutRateLimit,
  validateRequest(payoutRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { requestedAmount, bankDetails, notes } = req.body;

      // Verify user is a lawyer
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user || user.role !== 'LAWYER' || !user.lawyerProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only verified lawyers can request payouts']
        });
      }

      const lawyerId = user.lawyerProfile.id;

      // Check eligibility first
      const eligibility = await payoutManagerService.checkPayoutEligibility(lawyerId);

      if (!eligibility.isEligible) {
        return res.status(400).json({
          success: false,
          error: 'Payout request not eligible',
          details: eligibility.eligibilityReasons,
          eligibilityInfo: {
            minimumThreshold: eligibility.minimumThreshold,
            availableAmount: eligibility.availableAmount,
            nextEligibleDate: eligibility.nextEligibleDate
          }
        });
      }

      // Validate requested amount
      if (requestedAmount && requestedAmount > eligibility.availableAmount) {
        return res.status(400).json({
          success: false,
          error: 'Requested amount exceeds available balance',
          details: [`Available: ${eligibility.availableAmount} AZN, Requested: ${requestedAmount} AZN`]
        });
      }

      // Request payout
      const result = await payoutManagerService.requestPayout({
        lawyerId,
        requestedAmount,
        bankDetails,
        notes
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          details: []
        });
      }

      res.status(201).json({
        success: true,
        data: {
          payoutId: result.payoutId,
          amount: requestedAmount || eligibility.availableAmount,
          estimatedProcessingTime: result.estimatedProcessingTime,
          status: 'PENDING'
        },
        message: 'Payout request submitted successfully'
      });

    } catch (error) {
      console.error('Payout request error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process payout request',
        details: []
      });
    }
  }
);

/**
 * GET /api/payouts/status/:payoutId
 * Get detailed payout status and timeline
 */
router.get('/status/:payoutId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { payoutId } = req.params;
      const userId = req.auth!.userId;

      // Get payout details
      const payout = await payoutManagerService.getPayoutStatus(payoutId);

      if (!payout) {
        return res.status(404).json({
          success: false,
          error: 'Payout not found',
          details: []
        });
      }

      // Verify user has access to this payout
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user || !user.lawyerProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: []
        });
      }

      // Check if this payout belongs to the requesting lawyer
      const payoutRecord = await prisma.payout.findUnique({
        where: { id: payoutId }
      });

      if (payoutRecord?.lawyerId !== user.lawyerProfile.id) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only view your own payouts']
        });
      }

      // Generate status timeline
      const timeline = [
        {
          status: 'PENDING',
          timestamp: payout.requestedAt,
          description: 'Payout request submitted',
          completed: true
        },
        {
          status: 'PROCESSING',
          timestamp: payout.processedAt,
          description: 'Payout being processed',
          completed: !!payout.processedAt
        },
        {
          status: 'COMPLETED',
          timestamp: payout.completedAt,
          description: 'Payout completed successfully',
          completed: !!payout.completedAt
        }
      ];

      if (payout.failedAt) {
        timeline.push({
          status: 'FAILED',
          timestamp: payout.failedAt,
          description: `Payout failed: ${payout.failureReason}`,
          completed: true
        });
      }

      res.json({
        success: true,
        data: {
          ...payout,
          timeline,
          estimatedDelivery: payout.status === 'PROCESSING'
            ? '1-2 business days'
            : payout.status === 'COMPLETED'
            ? 'Delivered'
            : payout.status === 'FAILED'
            ? 'Failed'
            : '2-3 business days'
        }
      });

    } catch (error) {
      console.error('Get payout status error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get payout status',
        details: []
      });
    }
  }
);

/**
 * GET /api/payouts/history
 * Get lawyer's payout history
 */
router.get('/history',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const {
        status,
        limit = 20,
        offset = 0,
        dateFrom,
        dateTo
      } = req.query;

      // Verify user is a lawyer
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user || user.role !== 'LAWYER' || !user.lawyerProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only verified lawyers can access payout history']
        });
      }

      const lawyerId = user.lawyerProfile.id;

      // Build where clause
      const whereClause: any = { lawyerId };

      if (status) {
        whereClause.status = status;
      }

      if (dateFrom || dateTo) {
        whereClause.requestedAt = {};
        if (dateFrom) {
          whereClause.requestedAt.gte = new Date(dateFrom as string);
        }
        if (dateTo) {
          whereClause.requestedAt.lte = new Date(dateTo as string);
        }
      }

      // Get payouts
      const payouts = await prisma.payout.findMany({
        where: whereClause,
        orderBy: { requestedAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        select: {
          id: true,
          payoutReference: true,
          netAmount: true,
          currency: true,
          status: true,
          requestedAt: true,
          processedAt: true,
          completedAt: true,
          failedAt: true,
          failureReason: true,
          appointmentCount: true,
          periodStart: true,
          periodEnd: true
        }
      });

      // Get total count for pagination
      const totalCount = await prisma.payout.count({
        where: whereClause
      });

      // Calculate summary statistics
      const summary = await prisma.payout.aggregate({
        where: {
          lawyerId,
          status: 'COMPLETED'
        },
        _sum: {
          netAmount: true
        },
        _count: true
      });

      res.json({
        success: true,
        data: {
          payouts,
          pagination: {
            total: totalCount,
            limit: Number(limit),
            offset: Number(offset),
            hasMore: Number(offset) + payouts.length < totalCount
          },
          summary: {
            totalPayouts: summary._count,
            totalAmount: summary._sum.netAmount || 0,
            averagePayoutAmount: summary._count > 0 ? (summary._sum.netAmount || 0) / summary._count : 0
          }
        }
      });

    } catch (error) {
      console.error('Payout history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get payout history',
        details: []
      });
    }
  }
);

/**
 * GET /api/payouts/calculate
 * Calculate potential payout amount for lawyer
 */
router.get('/calculate',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { periodDays = 30 } = req.query;

      // Verify user is a lawyer
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user || user.role !== 'LAWYER' || !user.lawyerProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only verified lawyers can calculate payouts']
        });
      }

      const lawyerId = user.lawyerProfile.id;

      // Calculate payout for specified period
      const calculation = await payoutManagerService.calculateLawyerPayout(
        lawyerId,
        Number(periodDays)
      );

      res.json({
        success: true,
        data: {
          calculation,
          disclaimer: 'This is an estimate based on completed consultations. Actual payout may vary due to refunds, disputes, or policy changes.'
        }
      });

    } catch (error) {
      console.error('Calculate payout error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to calculate payout',
        details: []
      });
    }
  }
);

export default router;