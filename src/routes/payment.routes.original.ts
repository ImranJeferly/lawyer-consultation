import express, { Request, Response } from 'express';
import Joi from 'joi';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimit } from 'express-rate-limit';
import paymentCalculationService from '../services/paymentCalculation.service';
import escrowManagerService from '../services/escrowManager.service';
import prisma from '../config/database';
import { v4 as uuidv4 } from 'uuid';

enum ConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}

enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED'
}

const router = express.Router();

// Rate limiting for payment operations
const paymentRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 payment requests per windowMs
  message: {
    error: 'Too many payment requests, please try again later',
    retryAfter: '15 minutes'
  }
});

const highVolumeRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Higher limit for calculation requests
  message: {
    error: 'Too many requests, please try again later',
    retryAfter: '1 hour'
  }
});

// Validation schemas
const calculateCostSchema = Joi.object({
  lawyerId: Joi.string().required(),
  duration: Joi.number().min(15).max(240).required(),
  appointmentTime: Joi.string().isoDate().required(),
  consultationType: Joi.string().valid(...Object.values(ConsultationType)).required(),
  isUrgent: Joi.boolean().optional(),
  clientTimezone: Joi.string().optional(),
  promoCode: Joi.string().optional(),
  isFirstTimeClient: Joi.boolean().optional()
});

const initiatePaymentSchema = Joi.object({
  appointmentId: Joi.string().required(),
  paymentMethod: Joi.string().required(), // 'card', 'bank_transfer', 'wallet'
  savePaymentMethod: Joi.boolean().default(false),
  billingAddress: Joi.object({
    street: Joi.string().required(),
    city: Joi.string().required(),
    state: Joi.string().required(),
    zipCode: Joi.string().required(),
    country: Joi.string().required()
  }).optional()
});

const confirmPaymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  providerTransactionId: Joi.string().required(),
  paymentIntentId: Joi.string().optional(),
  paymentMethodDetails: Joi.object().optional()
});

const refundPaymentSchema = Joi.object({
  appointmentId: Joi.string().required(),
  reason: Joi.string().required(),
  refundType: Joi.string().valid('full', 'partial', 'cancellation_policy').default('cancellation_policy'),
  customAmount: Joi.number().min(0).optional()
});

/**
 * POST /api/payments/calculate-cost
 * Calculate total consultation cost with all modifiers
 */
router.post('/calculate-cost',
  highVolumeRateLimit,
  validateRequest(calculateCostSchema),
  async (req: Request, res: Response) => {
    try {
      const {
        lawyerId,
        duration,
        appointmentTime,
        consultationType,
        isUrgent = false,
        clientTimezone = 'UTC',
        promoCode,
        isFirstTimeClient = false
      } = req.body;

      // Calculate pricing with all modifiers
      const pricing = await paymentCalculationService.calculateWithDiscounts({
        lawyerId,
        duration,
        appointmentTime: new Date(appointmentTime),
        consultationType,
        isUrgent,
        clientTimezone,
        promoCode,
        isFirstTimeClient
      });

      // Validate pricing against lawyer's policies
      const validation = await paymentCalculationService.validatePricing(
        lawyerId,
        pricing.totalAmount
      );

      // Get platform fee breakdown for transparency
      const platformFeeBreakdown = await paymentCalculationService.getPlatformFeeBreakdown(lawyerId);

      res.json({
        success: true,
        data: {
          pricing,
          validation,
          platformFeeBreakdown,
          calculatedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString() // Valid for 15 minutes
        }
      });

    } catch (error) {
      console.error('Calculate cost error:', error);
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to calculate cost',
        details: []
      });
    }
  }
);

/**
 * POST /api/payments/initiate
 * Create payment record and prepare for external processing
 */
router.post('/initiate',
  requireAuth,
  paymentRateLimit,
  validateRequest(initiatePaymentSchema),
  async (req: Request, res: Response) => {
    try {
      const { appointmentId, paymentMethod, savePaymentMethod, billingAddress } = req.body;
      const userId = req.auth!.userId;

      // Get appointment details
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: { include: { user: true } }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Verify user owns this appointment
      if (appointment.clientId !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only pay for your own appointments']
        });
      }

      // Check if payment already exists
      const existingPayment = await prisma.payment.findUnique({
        where: { appointmentId }
      });

      if (existingPayment && existingPayment.status !== PaymentStatus.FAILED) {
        return res.status(400).json({
          success: false,
          error: 'Payment already exists for this appointment',
          details: [`Payment status: ${existingPayment.status}`]
        });
      }

      // Calculate current pricing
      const pricing = await paymentCalculationService.calculateConsultationCost({
        lawyerId: appointment.lawyerId,
        duration: appointment.consultationDuration,
        appointmentTime: appointment.startTime,
        consultationType: appointment.consultationType as ConsultationType,
        isUrgent: appointment.consultationType === ConsultationType.EMERGENCY
      });

      // Generate payment reference
      const paymentReference = `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create payment record
      const payment = await prisma.payment.create({
        data: {
          appointmentId,
          paymentReference,
          baseAmount: pricing.baseAmount,
          platformFee: pricing.platformFee,
          taxes: pricing.taxes,
          totalAmount: pricing.totalAmount,
          currency: 'AZN',
          status: PaymentStatus.PENDING,
          provider: 'STRIPE', // Default provider, can be changed based on client preference
          paymentMethod,
          // Risk assessment
          riskScore: 0, // Will be calculated by risk service
          riskLevel: 'LOW',
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        }
      });

      // Reserve the consultation time slot with extended lock
      // This prevents other users from booking during payment process
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          paymentStatus: 'PENDING',
          updatedAt: new Date()
        }
      });

      res.status(201).json({
        success: true,
        data: {
          paymentId: payment.id,
          paymentReference: payment.paymentReference,
          amount: payment.totalAmount,
          currency: payment.currency,
          breakdown: {
            baseAmount: payment.baseAmount,
            platformFee: payment.platformFee,
            taxes: payment.taxes,
            totalAmount: payment.totalAmount
          },
          appointment: {
            id: appointment.id,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            consultationType: appointment.consultationType,
            lawyer: {
              name: `${appointment.lawyer.user.firstName} ${appointment.lawyer.user.lastName}`,
              id: appointment.lawyer.id
            }
          },
          // External payment processing details
          externalProcessingRequired: true,
          paymentMethods: ['card', 'bank_transfer', 'wallet'],
          nextStep: 'Process payment with your chosen provider and call /confirm endpoint'
        }
      });

    } catch (error) {
      console.error('Initiate payment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to initiate payment',
        details: [error instanceof Error ? error.message : 'Internal server error']
      });
    }
  }
);

/**
 * POST /api/payments/confirm
 * Confirm payment was successful with external provider
 */
router.post('/confirm',
  requireAuth,
  paymentRateLimit,
  validateRequest(confirmPaymentSchema),
  async (req: Request, res: Response) => {
    try {
      const { paymentId, providerTransactionId, paymentIntentId, paymentMethodDetails } = req.body;
      const userId = req.auth!.userId;

      // Get payment record with appointment
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          appointment: {
            include: {
              client: true,
              lawyer: { include: { user: true } }
            }
          }
        }
      });

      if (!payment) {
        return res.status(404).json({
          success: false,
          error: 'Payment not found',
          details: []
        });
      }

      // Verify user owns this payment
      if (payment.appointment.clientId !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only confirm your own payments']
        });
      }

      // Check payment status
      if (payment.status !== PaymentStatus.PENDING) {
        return res.status(400).json({
          success: false,
          error: 'Payment cannot be confirmed',
          details: [`Payment status is ${payment.status}`]
        });
      }

      // Update payment to authorized status
      const updatedPayment = await prisma.$transaction(async (tx) => {
        // Update payment record
        const updated = await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.AUTHORIZED,
            providerTransactionId,
            paymentIntentId,
            authorizedAt: new Date(),
            ...(paymentMethodDetails && {
              lastFourDigits: paymentMethodDetails.lastFourDigits,
              expiryDate: paymentMethodDetails.expiryDate
            })
          }
        });

        // Update appointment status
        await tx.appointment.update({
          where: { id: payment.appointmentId },
          data: {
            paymentStatus: 'AUTHORIZED',
            status: 'CONFIRMED'
          }
        });

        return updated;
      });

      // Hold funds in escrow
      const escrowResult = await escrowManagerService.holdFunds({
        paymentId: updatedPayment.id,
        totalAmount: updatedPayment.totalAmount,
        lawyerAmount: updatedPayment.totalAmount - updatedPayment.platformFee - updatedPayment.taxes,
        platformAmount: updatedPayment.platformFee + updatedPayment.taxes
      });

      if (!escrowResult.success) {
        console.error('Escrow hold failed:', escrowResult.error);
        // Payment is authorized but escrow failed - needs manual review
      }

      // Log payment confirmation
      await prisma.paymentAuditLog.create({
        data: {
          paymentId: updatedPayment.id,
          action: 'payment_confirmed',
          previousStatus: PaymentStatus.PENDING,
          newStatus: PaymentStatus.AUTHORIZED,
          amount: updatedPayment.totalAmount,
          performedBy: userId,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          beforeState: { status: PaymentStatus.PENDING },
          afterState: {
            status: PaymentStatus.AUTHORIZED,
            providerTransactionId,
            authorizedAt: updatedPayment.authorizedAt
          }
        }
      });

      res.json({
        success: true,
        data: {
          paymentId: updatedPayment.id,
          status: updatedPayment.status,
          amount: updatedPayment.totalAmount,
          authorizedAt: updatedPayment.authorizedAt,
          appointment: {
            id: payment.appointment.id,
            status: 'CONFIRMED',
            startTime: payment.appointment.startTime,
            endTime: payment.appointment.endTime
          },
          escrow: {
            held: escrowResult.success,
            escrowId: escrowResult.escrowId
          }
        },
        message: 'Payment confirmed successfully. Your appointment is now confirmed.'
      });

    } catch (error) {
      console.error('Confirm payment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to confirm payment',
        details: [error instanceof Error ? error.message : 'Internal server error']
      });
    }
  }
);

/**
 * POST /api/payments/capture
 * Capture authorized payment after consultation completion
 */
router.post('/capture/:appointmentId',
  requireAuth,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const userId = req.auth!.userId;

      // Get appointment with payment
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          payment: true,
          lawyer: { include: { user: true } }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Only lawyer can capture payment after consultation
      if (appointment.lawyer.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only the lawyer can capture payment after consultation']
        });
      }

      // Check appointment status
      if (appointment.status !== 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: 'Appointment must be completed before capturing payment',
          details: [`Appointment status is ${appointment.status}`]
        });
      }

      if (!appointment.payment) {
        return res.status(404).json({
          success: false,
          error: 'No payment found for this appointment',
          details: []
        });
      }

      // Check payment status
      if (appointment.payment.status !== PaymentStatus.AUTHORIZED) {
        return res.status(400).json({
          success: false,
          error: 'Payment must be authorized before capture',
          details: [`Payment status is ${appointment.payment.status}`]
        });
      }

      // Release funds from escrow (this will capture payment and create payouts)
      const releaseResult = await escrowManagerService.releaseFunds({
        paymentId: appointment.payment.id,
        releaseType: 'full',
        reason: 'Consultation completed successfully',
        releasedBy: userId
      });

      if (!releaseResult.success) {
        return res.status(500).json({
          success: false,
          error: 'Failed to release funds from escrow',
          details: [releaseResult.error || 'Unknown error']
        });
      }

      res.json({
        success: true,
        data: {
          paymentId: appointment.payment.id,
          status: 'CAPTURED',
          capturedAmount: appointment.payment.totalAmount,
          capturedAt: new Date(),
          fundsReleased: true
        },
        message: 'Payment captured successfully. Funds have been released from escrow.'
      });

    } catch (error) {
      console.error('Capture payment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to capture payment',
        details: [error instanceof Error ? error.message : 'Internal server error']
      });
    }
  }
);

/**
 * POST /api/payments/refund
 * Process refunds based on cancellation policies
 */
router.post('/refund',
  requireAuth,
  paymentRateLimit,
  validateRequest(refundPaymentSchema),
  async (req: Request, res: Response) => {
    try {
      const { appointmentId, reason, refundType, customAmount } = req.body;
      const userId = req.auth!.userId;

      // Get appointment with payment
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          payment: true,
          client: true,
          lawyer: { include: { user: true } }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Check user permissions
      const isClient = appointment.clientId === userId;
      const isLawyer = appointment.lawyer.user.id === userId;

      if (!isClient && !isLawyer) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only request refunds for your own appointments']
        });
      }

      if (!appointment.payment) {
        return res.status(404).json({
          success: false,
          error: 'No payment found for this appointment',
          details: []
        });
      }

      // Calculate refund amount based on policy
      let refundCalculation;
      if (refundType === 'cancellation_policy') {
        refundCalculation = await paymentCalculationService.calculateRefundAmount(
          appointmentId,
          new Date()
        );
      } else if (refundType === 'partial' && customAmount) {
        refundCalculation = {
          originalAmount: appointment.payment.totalAmount,
          refundAmount: customAmount,
          cancellationFee: appointment.payment.totalAmount - customAmount,
          platformFeeRefund: 0,
          taxRefund: customAmount * 0.18,
          refundReason: 'Partial refund requested',
          isEligible: true,
          refundPercentage: (customAmount / appointment.payment.totalAmount) * 100
        };
      } else {
        refundCalculation = {
          originalAmount: appointment.payment.totalAmount,
          refundAmount: appointment.payment.totalAmount,
          cancellationFee: 0,
          platformFeeRefund: appointment.payment.platformFee,
          taxRefund: appointment.payment.taxes,
          refundReason: 'Full refund',
          isEligible: true,
          refundPercentage: 100
        };
      }

      if (!refundCalculation.isEligible) {
        return res.status(400).json({
          success: false,
          error: 'Refund not eligible',
          details: [refundCalculation.refundReason]
        });
      }

      // Create refund record
      const refundReference = `REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const refund = await prisma.refund.create({
        data: {
          paymentId: appointment.payment.id,
          refundReference,
          amount: refundCalculation.refundAmount,
          reason,
          refundType,
          status: 'PENDING'
        }
      });

      // Update payment status
      await prisma.payment.update({
        where: { id: appointment.payment.id },
        data: {
          status: refundCalculation.refundAmount >= appointment.payment.totalAmount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
          refundedAt: new Date()
        }
      });

      // Log refund processing
      await prisma.paymentAuditLog.create({
        data: {
          paymentId: appointment.payment.id,
          action: 'refund_processed',
          previousStatus: appointment.payment.status,
          newStatus: refund.status,
          amount: refundCalculation.refundAmount,
          performedBy: userId,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          reason,
          beforeState: { status: appointment.payment.status },
          afterState: {
            refundAmount: refundCalculation.refundAmount,
            refundReference: refund.refundReference
          }
        }
      });

      res.json({
        success: true,
        data: {
          refundId: refund.id,
          refundReference: refund.refundReference,
          amount: refund.amount,
          status: refund.status,
          calculation: refundCalculation,
          estimatedSettlement: '3-5 business days'
        },
        message: `Refund of ${refund.amount.toFixed(2)} AZN has been processed. ${refundCalculation.refundReason}`
      });

    } catch (error) {
      console.error('Refund payment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process refund',
        details: [error instanceof Error ? error.message : 'Internal server error']
      });
    }
  }
);

/**
 * GET /api/payments/history
 * Get complete payment history for user
 */
router.get('/history',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const {
        status,
        dateFrom,
        dateTo,
        limit = 20,
        offset = 0,
        exportFormat
      } = req.query;

      // Determine user role and build query
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { lawyerProfile: true }
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          details: []
        });
      }

      const isLawyer = user.role === 'LAWYER' && user.lawyerProfile;

      // Build where clause
      const whereClause: any = {};

      if (isLawyer) {
        whereClause.appointment = {
          lawyerId: user.lawyerProfile!.id
        };
      } else {
        whereClause.appointment = {
          clientId: userId
        };
      }

      if (status) {
        whereClause.status = status;
      }

      if (dateFrom || dateTo) {
        whereClause.createdAt = {};
        if (dateFrom) {
          whereClause.createdAt.gte = new Date(dateFrom as string);
        }
        if (dateTo) {
          whereClause.createdAt.lte = new Date(dateTo as string);
        }
      }

      const payments = await prisma.payment.findMany({
        where: whereClause,
        include: {
          appointment: {
            include: {
              client: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true
                }
              },
              lawyer: {
                include: {
                  user: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                      email: true
                    }
                  }
                }
              }
            }
          },
          refunds: true,
          escrow: true
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset)
      });

      // Calculate summary statistics
      const totalPayments = payments.length;
      const totalAmount = payments.reduce((sum, p) => sum + p.totalAmount, 0);
      const refundedAmount = payments.reduce((sum, p) =>
        sum + p.refunds.reduce((refundSum, r) => refundSum + r.amount, 0), 0
      );

      res.json({
        success: true,
        data: {
          payments: payments.map(payment => ({
            id: payment.id,
            paymentReference: payment.paymentReference,
            amount: payment.totalAmount,
            currency: payment.currency,
            status: payment.status,
            createdAt: payment.createdAt,
            authorizedAt: payment.authorizedAt,
            capturedAt: payment.capturedAt,
            appointment: {
              id: payment.appointment.id,
              startTime: payment.appointment.startTime,
              consultationType: payment.appointment.consultationType,
              duration: payment.appointment.consultationDuration,
              [isLawyer ? 'client' : 'lawyer']: isLawyer
                ? {
                    name: `${payment.appointment.client.firstName} ${payment.appointment.client.lastName}`,
                    email: payment.appointment.client.email
                  }
                : {
                    name: `${payment.appointment.lawyer.user.firstName} ${payment.appointment.lawyer.user.lastName}`,
                    email: payment.appointment.lawyer.user.email
                  }
            },
            refunds: payment.refunds,
            escrowStatus: payment.escrow?.status
          })),
          summary: {
            totalPayments,
            totalAmount,
            refundedAmount,
            netAmount: totalAmount - refundedAmount
          },
          pagination: {
            limit: Number(limit),
            offset: Number(offset),
            hasMore: payments.length === Number(limit)
          }
        }
      });

    } catch (error) {
      console.error('Payment history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get payment history',
        details: []
      });
    }
  }
);

export default router;