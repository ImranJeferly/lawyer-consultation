import express, { Request, Response } from 'express';
import Joi from 'joi';
import { requireAuth } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimit } from 'express-rate-limit';
import availabilityCalculationService from '../services/availabilityCalculation.service';
import bookingConflictPreventionService from '../services/bookingConflictPrevention.service';
import notificationService from '../services/notification.service';
import paymentCalculationService from '../services/paymentCalculation.service';
import paymentProcessorService, { TempPaymentProvider } from '../services/paymentProcessor.service';
import payoutProcessorService from '../services/payoutProcessor.service';
import riskManagerService from '../services/riskManager.service';
import loggingService from '../services/logging.service';
import prisma from '../config/database';
import { NotificationType } from '@prisma/client';
// Temporary enum until Prisma client is regenerated



enum ConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}
import { addMinutes, addDays } from 'date-fns';
import * as tz from 'date-fns-tz';

const router = express.Router();

const zonedTimeToUtc = (tz as any).zonedTimeToUtc as (date: string | Date, timeZone: string) => Date;

// Rate limiting for booking operations
const bookingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 booking requests per windowMs
  message: {
    error: 'Too many booking requests, please try again later',
    retryAfter: '15 minutes'
  }
});

const createBookingRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 booking creations per hour
  message: {
    error: 'Too many booking attempts, please try again later',
    retryAfter: '1 hour'
  }
});

const userScopedKeyGenerator = (req: Request) => {
  const auth = (req as any).auth;
  if (auth?.userId) {
    return `user-${auth.userId}`;
  }
  return req.ip || 'unknown-ip';
};

const cancellationRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: userScopedKeyGenerator,
  message: {
    error: 'Too many cancellation requests, please try again later',
    retryAfter: '1 hour'
  }
});

const rescheduleRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: userScopedKeyGenerator,
  message: {
    error: 'Too many reschedule attempts, please try again later',
    retryAfter: '1 hour'
  }
});

// Validation schemas
const availabilityQuerySchema = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  consultationType: Joi.string().valid(...Object.values(ConsultationType)).optional(),
  duration: Joi.number().min(15).max(240).optional(),
  timezone: Joi.string().optional(),
  includeUnavailable: Joi.boolean().optional()
});

const checkAvailabilitySchema = Joi.object({
  startTime: Joi.string().isoDate().required(),
  duration: Joi.number().min(15).max(240).required(),
  consultationType: Joi.string().valid(...Object.values(ConsultationType)).required()
});

const createBookingSchema = Joi.object({
  lawyerId: Joi.string().required(),
  startTime: Joi.string().isoDate().required(),
  duration: Joi.number().min(15).max(240).required(),
  consultationType: Joi.string().valid(...Object.values(ConsultationType)).required(),
  clientNotes: Joi.string().max(1000).optional(),
  clientTimezone: Joi.string().optional(),
  lockId: Joi.string().optional() // From booking lock process
});

const cancelBookingSchema = Joi.object({
  reason: Joi.string().max(500).required(),
  requestRefund: Joi.boolean().default(true)
});

const rescheduleSchema = Joi.object({
  newStartTime: Joi.string().isoDate().required(),
  newDuration: Joi.number().min(15).max(240).optional(),
  reason: Joi.string().max(500).optional(),
  timezone: Joi.string().optional()
});

/**
 * GET /api/bookings/availability/:lawyerId
 * Get lawyer's available time slots
 */
router.get('/availability/:lawyerId',
  bookingRateLimit,
  validateRequest(availabilityQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const { lawyerId } = req.params;
      const query = {
        lawyerId,
        ...req.query
      };

      const availability = await availabilityCalculationService.getAvailableSlots(query as any);

      res.json({
        success: true,
        data: availability
      });

    } catch (error) {
      console.error('Get availability error:', error);
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get availability',
        details: []
      });
    }
  }
);

/**
 * POST /api/bookings/check-availability
 * Check specific time slot availability in real-time
 */
router.post('/check-availability/:lawyerId',
  requireAuth,
  bookingRateLimit,
  validateRequest(checkAvailabilitySchema),
  async (req: Request, res: Response) => {
    try {
      const { lawyerId } = req.params;
      const { startTime, duration, consultationType } = req.body;

      const startTimeDate = new Date(startTime);
      const availability = await availabilityCalculationService.isSlotAvailable(
        lawyerId,
        startTimeDate,
        duration,
        consultationType
      );

      if (availability.isAvailable) {
        // Create a temporary booking lock
        const lockResult = await bookingConflictPreventionService.createBookingLock({
          lawyerId,
          startTime: startTimeDate,
          endTime: addMinutes(startTimeDate, duration),
          consultationType,
          userId: req.auth!.userId,
          durationMinutes: 10 // 10-minute lock
        });

        res.json({
          success: true,
          data: {
            isAvailable: true,
            pricing: availability.pricing,
            lockId: lockResult.lockId,
            lockExpiresIn: 600, // 10 minutes in seconds
            message: 'Time slot reserved for 10 minutes'
          }
        });
      } else {
        res.json({
          success: true,
          data: {
            isAvailable: false,
            reason: availability.conflictReason,
            message: 'Time slot not available'
          }
        });
      }

    } catch (error) {
      console.error('Check availability error:', error);
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check availability',
        details: []
      });
    }
  }
);

/**
 * POST /api/bookings/create
 * Create new appointment booking
 */
router.post('/create',
  requireAuth,
  createBookingRateLimit,
  validateRequest(createBookingSchema),
  async (req: Request, res: Response) => {
    try {
      const {
        lawyerId,
        startTime,
        duration,
        consultationType,
        clientNotes,
        clientTimezone,
        lockId
      } = req.body;

      const userId = req.auth!.userId;

      const [lawyerProfile, client] = await Promise.all([
        prisma.lawyerProfile.findUnique({
          where: { id: lawyerId },
          include: {
            bookingPolicy: true,
            user: true
          }
        }),
        prisma.user.findUnique({ where: { id: userId } })
      ]);

      if (!lawyerProfile) {
        return res.status(404).json({
          success: false,
          error: 'Lawyer not found',
          details: []
        });
      }

      const clientTimeZone = clientTimezone || client?.timezone || 'UTC';
      const lawyerTimeZone = lawyerProfile.timezone || lawyerProfile.user.timezone || 'UTC';
      const slotHasOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(startTime);
      const startTimeDate = slotHasOffset ? new Date(startTime) : zonedTimeToUtc(startTime, clientTimeZone);

      if (Number.isNaN(startTimeDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start time provided',
          details: []
        });
      }

      const endTimeDate = addMinutes(startTimeDate, duration);
      const bufferTimeMinutes = lawyerProfile.bookingPolicy?.bufferTimeMinutes ?? 15;

      // Calculate pricing with all modifiers and fees
      const pricing = await paymentCalculationService.calculateConsultationCost({
        lawyerId,
        duration,
        appointmentTime: startTimeDate,
        consultationType,
        clientTimezone: clientTimeZone,
        discountCode: req.body.discountCode,
        promoCode: req.body.promoCode
      });

      // Get availability information
      const availability = await availabilityCalculationService.isSlotAvailable(
        lawyerId,
        startTimeDate,
        duration,
        consultationType
      );

      if (!availability.isAvailable) {
        // Release lock if provided
        if (lockId) {
          await bookingConflictPreventionService.releaseBookingLock(lockId);
        }

        return res.status(400).json({
          success: false,
          error: 'Time slot no longer available',
          details: [availability.conflictReason || 'Slot unavailable']
        });
      }

      // Perform comprehensive risk assessment
      const riskAssessment = await riskManagerService.calculateRiskScore({
        userId,
        amount: pricing.totalAmount,
        appointmentTime: startTimeDate,
        consultationType,
        paymentMethod: req.body.paymentMethod || 'card',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Create booking atomically
      const bookingResult = await bookingConflictPreventionService.atomicBookingCreation({
        lawyerId,
        clientId: userId,
        startTime: startTimeDate,
        endTime: endTimeDate,
        consultationType,
        duration,
        totalAmount: pricing.totalAmount,
        clientTimeZone,
        lawyerTimeZone,
        bufferTimeMinutes,
        clientNotes,
        lockId
      });

      if (!bookingResult.success) {
        return res.status(400).json({
          success: false,
          error: bookingResult.error || 'Failed to create booking',
          details: []
        });
      }

      const paymentInit = await paymentProcessorService.initiatePayment({
        appointmentId: bookingResult.appointmentId!,
        userId,
        provider: TempPaymentProvider.STRIPE,
        currency: pricing.currency,
        clientLocation: req.headers['x-client-location'] as string | undefined,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      });

      if (!paymentInit.success) {
        await prisma.appointment.update({
          where: { id: bookingResult.appointmentId },
          data: {
            status: 'CANCELLED',
            cancellationReason: 'Payment initiation failed',
            cancelledAt: new Date(),
            cancelledBy: userId
          }
        });

        return res.status(502).json({
          success: false,
          error: paymentInit.error || 'Failed to initiate payment',
          details: [],
          data: {
            appointmentId: bookingResult.appointmentId
          }
        });
      }

      // Send confirmation notifications
      try {
        const appointmentForNotification = await prisma.appointment.findUnique({
          where: { id: bookingResult.appointmentId },
          include: {
            client: true,
            lawyer: { include: { user: true } }
          }
        });

        if (appointmentForNotification) {
          // Send booking confirmation notification
          try {
            await notificationService.sendNotification({
              recipientId: appointmentForNotification.clientId,
              title: 'Booking Confirmed',
              message: `Your appointment with ${appointmentForNotification.lawyer.user.firstName} ${appointmentForNotification.lawyer.user.lastName} has been confirmed.`,
              notificationType: 'BOOKING_CONFIRMED'
            });
          } catch (error) {
            console.error('Failed to send booking confirmation:', error);
          }
        }
      } catch (notificationError) {
        console.error('Notification error:', notificationError);
        // Don't fail the booking if notifications fail
      }

      res.status(201).json({
        success: true,
        data: {
          appointmentId: bookingResult.appointmentId,
          pricing: {
            baseAmount: pricing.baseAmount,
            platformFee: pricing.platformFee,
            taxes: pricing.taxes,
            totalAmount: pricing.totalAmount,
            currency: pricing.currency,
            breakdown: pricing.breakdown
          },
          payment: {
            paymentId: paymentInit.paymentId,
            paymentReference: paymentInit.paymentReference,
            requiresAction: paymentInit.requiresAction,
            actionUrl: paymentInit.actionUrl,
            currency: paymentInit.currency || pricing.currency,
            totalAmount: paymentInit.totalAmount ?? pricing.totalAmount,
            riskAssessment: paymentInit.riskAssessment
          },
          riskAssessment: {
            riskLevel: riskAssessment.riskLevel,
            requiresVerification: riskAssessment.riskLevel === 'HIGH',
            monitoring: riskAssessment.riskLevel === 'MEDIUM' || riskAssessment.riskLevel === 'HIGH'
          },
          nextSteps: {
            paymentRequired: true,
            paymentUrl: `/api/payments/initiate`,
            appointmentConfirmation: 'Pending payment authorization'
          }
        },
        message: 'Appointment booked successfully. Please proceed with payment to confirm.'
      });

    } catch (error) {
      console.error('Create booking error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create booking',
        details: [error instanceof Error ? error.message : 'Internal server error']
      });
    }
  }
);

/**
 * GET /api/bookings/my-appointments
 * Get user's appointments (client or lawyer view)
 */
router.get('/my-appointments',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = req.auth!.userId;
      const { status, upcoming, limit = 20, offset = 0 } = req.query;

      // Determine user role
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
      const whereClause: any = {};

      if (isLawyer) {
        whereClause.lawyerId = user.lawyerProfile!.id;
      } else {
        whereClause.clientId = userId;
      }

      // Filter by status
      if (status) {
        whereClause.status = status;
      }

      // Filter by upcoming/past
      if (upcoming === 'true') {
        whereClause.startTime = { gte: new Date() };
      } else if (upcoming === 'false') {
        whereClause.startTime = { lt: new Date() };
      }

      const appointments = await prisma.appointment.findMany({
        where: whereClause,
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
        },
        orderBy: { startTime: 'asc' },
        take: Number(limit),
        skip: Number(offset)
      });

      res.json({
        success: true,
        data: {
          appointments,
          totalCount: appointments.length,
          userRole: isLawyer ? 'lawyer' : 'client'
        }
      });

    } catch (error) {
      console.error('Get appointments error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get appointments',
        details: []
      });
    }
  }
);

/**
 * GET /api/bookings/:appointmentId
 * Get detailed appointment information
 */
router.get('/:appointmentId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const userId = req.auth!.userId;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: {
            include: {
              user: true
            }
          }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Check if user has access to this appointment
      const hasAccess = appointment.clientId === userId ||
                       appointment.lawyer.user.id === userId;

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You do not have permission to view this appointment']
        });
      }

      res.json({
        success: true,
        data: { appointment }
      });

    } catch (error) {
      console.error('Get appointment details error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get appointment details',
        details: []
      });
    }
  }
);

/**
 * PUT /api/bookings/:appointmentId/cancel
 * Cancel an existing appointment
 */
router.put('/:appointmentId/cancel',
  requireAuth,
  cancellationRateLimit,
  validateRequest(cancelBookingSchema),
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const { reason, requestRefund } = req.body;
      const userId = req.auth!.userId;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          lawyer: {
            include: {
              bookingPolicy: true,
              user: true
            }
          }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Check permissions
      if (appointment.clientId !== userId && appointment.lawyer.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only cancel your own appointments']
        });
      }

      // Check if appointment can be cancelled
      if (appointment.status === 'CANCELLED' || appointment.status === 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: 'Appointment cannot be cancelled',
          details: [`Appointment is already ${appointment.status.toLowerCase()}`]
        });
      }

      // Calculate refund amount based on cancellation policy
      const now = new Date();
      const hoursUntilAppointment = (appointment.startTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      const policy = appointment.lawyer.bookingPolicy;

      let refundAmount = 0;
      let refundPercentage = 0;

      if (hoursUntilAppointment < 0) {
        return res.status(400).json({
          success: false,
          error: 'Appointment already started or completed',
          details: ['Cannot cancel an appointment that has already passed']
        });
      }

      if (policy && hoursUntilAppointment < policy.noCancellationHours && appointment.lawyer.user.id !== userId) {
        return res.status(400).json({
          success: false,
          error: 'Cancellation window closed',
          details: [`Cancellations must be made at least ${policy.noCancellationHours} hours before the appointment`]
        });
      }

      if (requestRefund && policy) {
        if (hoursUntilAppointment >= policy.freeCancellationHours) {
          refundPercentage = 100;
          refundAmount = appointment.totalAmount;
        } else if (hoursUntilAppointment >= policy.noCancellationHours) {
          refundPercentage = 100 - policy.cancellationFeePercentage;
          refundAmount = appointment.totalAmount * (refundPercentage / 100);
        } else {
          refundPercentage = 0;
          refundAmount = 0;
        }
      }

      // Update appointment
      const updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'CANCELLED',
          cancellationReason: reason,
          cancelledAt: now,
          cancelledBy: userId,
          refundAmount: refundAmount,
          refundStatus: refundAmount > 0 ? 'PENDING' : 'NONE'
        }
      });

      const targetUserId = appointment.clientId === userId ? appointment.lawyer.user.id : appointment.clientId;
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'BOOKING_CANCELLED',
          eventData: {
            appointmentId,
            reason,
            refundAmount,
            refundPercentage,
            cancelledByRole: appointment.clientId === userId ? 'client' : 'lawyer'
          },
          initiatedBy: userId,
          targetUserId,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent') || undefined
        }
      });

      // TODO: Process actual refund if refundAmount > 0
      // TODO: Send cancellation notifications
      // TODO: Update calendar events

      res.json({
        success: true,
        data: {
          appointment: {
            id: updatedAppointment.id,
            status: updatedAppointment.status,
            cancellationReason: updatedAppointment.cancellationReason,
            cancelledAt: updatedAppointment.cancelledAt,
            refundAmount: updatedAppointment.refundAmount,
            refundPercentage
          }
        },
        message: `Appointment cancelled successfully${refundAmount > 0 ? `. Refund of $${refundAmount.toFixed(2)} will be processed within 3-5 business days.` : ''}`
      });

    } catch (error) {
      console.error('Cancel appointment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cancel appointment',
        details: []
      });
    }
  }
);

/**
 * PUT /api/bookings/:appointmentId/reschedule
 * Reschedule an existing appointment
 */
router.put('/:appointmentId/reschedule',
  requireAuth,
  rescheduleRateLimit,
  validateRequest(rescheduleSchema),
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const { newStartTime, newDuration, reason } = req.body;
      const userId = req.auth!.userId;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: {
            include: {
              bookingPolicy: true,
              user: true
            }
          }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Check permissions
      if (appointment.clientId !== userId && appointment.lawyer.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only reschedule your own appointments']
        });
      }

      // Check if appointment can be rescheduled
      if (appointment.status !== 'PENDING' && appointment.status !== 'CONFIRMED') {
        return res.status(400).json({
          success: false,
          error: 'Appointment cannot be rescheduled',
          details: [`Only pending or confirmed appointments can be rescheduled`]
        });
      }

      const requestedTimezone = req.body.timezone
        || (appointment.clientId === userId
          ? appointment.clientTimeZone || appointment.client?.timezone || 'UTC'
          : appointment.lawyerTimeZone || appointment.lawyer.timezone || appointment.lawyer.user.timezone || 'UTC');

      const rescheduleHasOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(newStartTime);
      const newStartTimeDate = rescheduleHasOffset ? new Date(newStartTime) : zonedTimeToUtc(newStartTime, requestedTimezone);

      if (Number.isNaN(newStartTimeDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid reschedule time provided',
          details: []
        });
      }

      const duration = newDuration || appointment.consultationDuration;
      const newEndTimeDate = addMinutes(newStartTimeDate, duration);

      // Calculate reschedule fee
      const now = new Date();
      if (newStartTimeDate <= now) {
        return res.status(400).json({
          success: false,
          error: 'Reschedule must be in the future',
          details: []
        });
      }

      const hoursUntilAppointment = (appointment.startTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      const policy = appointment.lawyer.bookingPolicy;

      let rescheduleFee = 0;
      if (policy && hoursUntilAppointment < policy.freeReschedulingHours) {
        rescheduleFee = policy.reschedulingFee;
      }

      if (policy && hoursUntilAppointment < policy.noCancellationHours) {
        return res.status(400).json({
          success: false,
          error: 'Reschedule window closed',
          details: [`Reschedules must be made at least ${policy.noCancellationHours} hours before the appointment`]
        });
      }

      // Check reschedule limits
      if (policy && appointment.rescheduleCount >= policy.maxReschedulingCount) {
        return res.status(400).json({
          success: false,
          error: 'Reschedule limit exceeded',
          details: [`Maximum of ${policy.maxReschedulingCount} reschedules allowed`]
        });
      }

      // Validate new time slot availability
      const validation = await bookingConflictPreventionService.validateBooking({
        lawyerId: appointment.lawyerId,
        clientId: appointment.clientId,
        startTime: newStartTimeDate,
        endTime: newEndTimeDate,
        consultationType: appointment.consultationType as ConsultationType,
        duration
      });

      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: 'New time slot not available',
          details: validation.errors
        });
      }

      // Update appointment
      const previousStartTime = appointment.startTime;
      const previousDuration = appointment.consultationDuration;

      const updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          startTime: newStartTimeDate,
          endTime: newEndTimeDate,
          consultationDuration: duration,
          rescheduleCount: { increment: 1 },
          // Add reschedule fee to total if applicable
          totalAmount: rescheduleFee > 0 ? { increment: rescheduleFee } : undefined,
          updatedAt: new Date()
        }
      });

      const targetUserId = appointment.clientId === userId ? appointment.lawyer.user.id : appointment.clientId;
      await prisma.communicationAuditLog.create({
        data: {
          eventType: 'BOOKING_RESCHEDULED',
          eventData: {
            appointmentId,
            previousStartTime,
            newStartTime: updatedAppointment.startTime,
            previousDuration,
            newDuration: updatedAppointment.consultationDuration,
            reason,
            rescheduleFee
          },
          initiatedBy: userId,
          targetUserId,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent') || undefined
        }
      });

      // TODO: Process reschedule fee payment if applicable
      // TODO: Send reschedule notifications
      // TODO: Update calendar events

      res.json({
        success: true,
        data: {
          appointment: {
            id: updatedAppointment.id,
            startTime: updatedAppointment.startTime,
            endTime: updatedAppointment.endTime,
            consultationDuration: updatedAppointment.consultationDuration,
            rescheduleCount: updatedAppointment.rescheduleCount,
            totalAmount: updatedAppointment.totalAmount,
            rescheduleFee
          }
        },
        message: `Appointment rescheduled successfully${rescheduleFee > 0 ? `. A reschedule fee of $${rescheduleFee} has been added.` : ''}`
      });

    } catch (error) {
      console.error('Reschedule appointment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reschedule appointment',
        details: []
      });
    }
  }
);

/**
 * POST /api/bookings/:appointmentId/start
 * Start a consultation session
 */
router.post('/:appointmentId/start',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const userId = req.auth!.userId;

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

      // Only lawyer can start the session
      if (appointment.lawyer.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only the lawyer can start the consultation']
        });
      }

      // Check if appointment can be started
      const now = new Date();
      const timeUntilStart = appointment.startTime.getTime() - now.getTime();
      const minutesUntilStart = timeUntilStart / (1000 * 60);

      if (minutesUntilStart > 15) {
        return res.status(400).json({
          success: false,
          error: 'Too early to start',
          details: ['Consultation can only be started 15 minutes before scheduled time']
        });
      }

      if (appointment.status !== 'CONFIRMED') {
        return res.status(400).json({
          success: false,
          error: 'Appointment not confirmed',
          details: ['Only confirmed appointments can be started']
        });
      }

      // Update appointment to in progress
      const updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'IN_PROGRESS',
          consultationStartedAt: now
        }
      });

      // TODO: Create video meeting room
      // TODO: Send notifications to client

      res.json({
        success: true,
        data: {
          appointment: {
            id: updatedAppointment.id,
            status: updatedAppointment.status,
            consultationStartedAt: updatedAppointment.consultationStartedAt,
            meetingLink: updatedAppointment.meetingLink || 'Meeting link will be generated'
          }
        },
        message: 'Consultation session started successfully'
      });

    } catch (error) {
      console.error('Start consultation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to start consultation',
        details: []
      });
    }
  }
);

/**
 * PUT /api/bookings/:appointmentId/confirm
 * Lawyer confirms appointment acceptance
 */
router.put('/:appointmentId/confirm',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const userId = req.auth!.userId;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: {
            include: {
              user: true
            }
          }
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Only lawyer can confirm the appointment
      if (appointment.lawyer.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only the lawyer can confirm the appointment']
        });
      }

      // Check if appointment can be confirmed
      if (appointment.status !== 'PENDING') {
        return res.status(400).json({
          success: false,
          error: 'Appointment cannot be confirmed',
          details: [`Appointment status is ${appointment.status}`]
        });
      }

      // Update appointment to confirmed
      const updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'CONFIRMED',
          updatedAt: new Date()
        }
      });

      // TODO: Send confirmation notifications
      // TODO: Create consultation preparation checklist

      res.json({
        success: true,
        data: {
          appointment: {
            id: updatedAppointment.id,
            status: updatedAppointment.status,
            confirmedAt: updatedAppointment.updatedAt
          }
        },
        message: 'Appointment confirmed successfully'
      });

    } catch (error) {
      console.error('Confirm appointment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to confirm appointment',
        details: []
      });
    }
  }
);

/**
 * POST /api/bookings/:appointmentId/complete
 * Marks consultation as completed
 */
router.post('/:appointmentId/complete',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { appointmentId } = req.params;
      const { lawyerNotes, clientSatisfactionRating } = req.body;
      const userId = req.auth!.userId;

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: {
            include: {
              user: true
            }
          },
          payment: true
        }
      });

      if (!appointment) {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found',
          details: []
        });
      }

      // Only lawyer can mark as completed (usually)
      const isLawyer = appointment.lawyer.user.id === userId;
      const isClient = appointment.clientId === userId;

      if (!isLawyer && !isClient) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['Only participants can mark consultation as completed']
        });
      }

      // Check if appointment can be completed
      if (appointment.status !== 'IN_PROGRESS') {
        return res.status(400).json({
          success: false,
          error: 'Appointment cannot be completed',
          details: [`Only in-progress appointments can be completed`]
        });
      }

      const now = new Date();
      const actualDuration = appointment.consultationStartedAt
        ? Math.round((now.getTime() - appointment.consultationStartedAt.getTime()) / (1000 * 60))
        : appointment.consultationDuration;

      const reviewReminderDate = addDays(now, 3);
      const existingSummary = (appointment.consultationSummary as Record<string, any> | null) ?? {};
      const updatedSummary: Record<string, any> = {
        ...existingSummary,
        reviewInvitation: {
          ...(existingSummary.reviewInvitation ?? {}),
          initialPromptSentAt: now.toISOString(),
          reminderScheduledFor: reviewReminderDate.toISOString(),
          status: 'pending'
        }
      };

      if (typeof clientSatisfactionRating === 'number') {
        updatedSummary.clientSatisfaction = {
          rating: clientSatisfactionRating,
          updatedAt: now.toISOString()
        };
      }

      // Update appointment to completed
      const updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'COMPLETED',
          consultationEndedAt: now,
          actualDuration,
          lawyerNotes: isLawyer && typeof lawyerNotes === 'string' ? lawyerNotes : appointment.lawyerNotes,
          updatedAt: now,
          consultationSummary: updatedSummary as any
        }
      });

      loggingService.logUserAction('Consultation completed', {
        appointmentId,
        completedBy: userId,
        actualDuration
      });

      const workflowSummary = {
        paymentCapture: {
          attempted: false,
          success: false,
          message: 'Not attempted' as string,
          paymentId: undefined as string | undefined,
          paymentReference: undefined as string | undefined
        },
        payout: {
          attempted: false,
          success: false,
          message: 'Not attempted' as string,
          payoutId: undefined as string | undefined,
          amount: undefined as number | undefined,
          currency: undefined as string | undefined
        },
        notifications: [] as Array<{ recipientId: string; type: string; scheduledFor?: string | null }>
      };

      // Attempt to capture authorized payment
      if (appointment.payment) {
        workflowSummary.paymentCapture.attempted = true;

        if (appointment.payment.status === 'AUTHORIZED') {
          try {
            const captureResult = await paymentProcessorService.capturePayment(appointment.payment.id, userId);

            if (captureResult.success) {
              workflowSummary.paymentCapture.success = true;
              workflowSummary.paymentCapture.message = 'Payment captured successfully';
              workflowSummary.paymentCapture.paymentId = appointment.payment.id;
              workflowSummary.paymentCapture.paymentReference = captureResult.paymentReference;

              await prisma.appointment.update({
                where: { id: appointmentId },
                data: {
                  paymentStatus: 'CAPTURED',
                  paymentCaptureId: appointment.payment.id
                }
              });

              loggingService.logPayment('Payment captured for appointment', {
                appointmentId,
                paymentId: appointment.payment.id,
                capturedBy: userId
              });

              try {
                await notificationService.sendNotification({
                  recipientId: appointment.clientId,
                  title: 'Payment processed successfully',
                  message: `We’ve processed the payment for your consultation with ${appointment.lawyer.user.firstName} ${appointment.lawyer.user.lastName}.`,
                  notificationType: NotificationType.PAYMENT_CAPTURED,
                  metadata: {
                    appointmentId,
                    paymentId: appointment.payment.id
                  }
                });

                workflowSummary.notifications.push({
                  recipientId: appointment.clientId,
                  type: NotificationType.PAYMENT_CAPTURED
                });
              } catch (notificationError) {
                loggingService.logError(notificationError as Error, undefined, {
                  operation: 'sendPaymentCaptureNotification',
                  appointmentId,
                  recipientId: appointment.clientId
                });
              }
            } else {
              workflowSummary.paymentCapture.message = captureResult.error || 'Failed to capture payment';
              loggingService.logPayment('Payment capture failed', {
                appointmentId,
                paymentId: appointment.payment.id,
                error: captureResult.error
              });
            }
          } catch (captureError) {
            workflowSummary.paymentCapture.message = 'Payment capture encountered an error';
            loggingService.logError(captureError as Error, undefined, {
              operation: 'capturePayment',
              appointmentId,
              paymentId: appointment.payment.id
            });
          }
        } else {
          workflowSummary.paymentCapture.message = `Payment status ${appointment.payment.status} not eligible for capture`;
        }
      } else {
        workflowSummary.paymentCapture.message = 'No payment record associated with appointment';
      }

      // Schedule payout if payment was captured
      if (workflowSummary.paymentCapture.success) {
        workflowSummary.payout.attempted = true;

        try {
          const payoutResult = await payoutProcessorService.createPayout({
            lawyerId: appointment.lawyerId,
            requestedBy: 'system',
            reason: `Automated payout scheduled after appointment ${appointmentId}`
          });

          if (payoutResult.success) {
            workflowSummary.payout.success = true;
            workflowSummary.payout.message = 'Payout request created';
            workflowSummary.payout.payoutId = payoutResult.payoutId;
            workflowSummary.payout.amount = payoutResult.netAmount;
            workflowSummary.payout.currency = payoutResult.currency;

            const payoutAmountText = payoutResult.netAmount !== undefined && payoutResult.currency
              ? `${payoutResult.netAmount.toFixed(2)} ${payoutResult.currency}`
              : 'your recent earnings';

            try {
              await notificationService.sendNotification({
                recipientId: appointment.lawyer.user.id,
                title: 'Payout scheduled',
                message: `We’ve scheduled a payout for ${payoutAmountText}. You’ll receive a separate notification once it’s processed.`,
                notificationType: NotificationType.PAYMENT_CAPTURED,
                metadata: {
                  appointmentId,
                  payoutId: payoutResult.payoutId
                }
              });

              workflowSummary.notifications.push({
                recipientId: appointment.lawyer.user.id,
                type: NotificationType.PAYMENT_CAPTURED
              });
            } catch (payoutNotificationError) {
              loggingService.logError(payoutNotificationError as Error, undefined, {
                operation: 'sendPayoutNotification',
                appointmentId,
                lawyerId: appointment.lawyerId
              });
            }
          } else {
            workflowSummary.payout.message = payoutResult.error || 'Payout scheduling failed';
            loggingService.logPayment('Payout scheduling skipped', {
              appointmentId,
              lawyerId: appointment.lawyerId,
              reason: payoutResult.error || 'Unknown error'
            });
          }
        } catch (payoutError) {
          workflowSummary.payout.message = 'Payout scheduling encountered an error';
          loggingService.logError(payoutError as Error, undefined, {
            operation: 'schedulePayout',
            appointmentId,
            lawyerId: appointment.lawyerId
          });
        }
      }

      // Send consultation completion notifications and review prompts
      try {
        await notificationService.sendNotification({
          recipientId: appointment.clientId,
          title: 'Thanks for your consultation',
          message: `Your consultation with ${appointment.lawyer.user.firstName} ${appointment.lawyer.user.lastName} has ended. Let us know how it went by leaving a review.`,
          notificationType: NotificationType.CONSULTATION_ENDED,
          metadata: {
            appointmentId,
            action: 'review_prompt'
          }
        });

        workflowSummary.notifications.push({
          recipientId: appointment.clientId,
          type: NotificationType.CONSULTATION_ENDED
        });
      } catch (completionNotificationError) {
        loggingService.logError(completionNotificationError as Error, undefined, {
          operation: 'sendConsultationCompletionNotification',
          appointmentId,
          recipientId: appointment.clientId
        });
      }

      try {
        await notificationService.sendNotification({
          recipientId: appointment.clientId,
          title: 'Reminder: share your feedback',
          message: `We’d love to hear about your consultation with ${appointment.lawyer.user.firstName} ${appointment.lawyer.user.lastName}. Leave a review when you have a moment.`,
          notificationType: NotificationType.CONSULTATION_ENDED,
          scheduledFor: reviewReminderDate,
          metadata: {
            appointmentId,
            action: 'review_reminder'
          }
        });

        workflowSummary.notifications.push({
          recipientId: appointment.clientId,
          type: NotificationType.CONSULTATION_ENDED,
          scheduledFor: reviewReminderDate.toISOString()
        });
      } catch (reviewReminderError) {
        loggingService.logError(reviewReminderError as Error, undefined, {
          operation: 'scheduleReviewReminder',
          appointmentId,
          recipientId: appointment.clientId
        });
      }

      try {
        await notificationService.sendNotification({
          recipientId: appointment.lawyer.user.id,
          title: 'Consultation completed',
          message: `${appointment.client.firstName} ${appointment.client.lastName} marked your consultation as complete. We’ve started processing the payment.`,
          notificationType: NotificationType.CONSULTATION_ENDED,
          metadata: {
            appointmentId
          }
        });

        workflowSummary.notifications.push({
          recipientId: appointment.lawyer.user.id,
          type: NotificationType.CONSULTATION_ENDED
        });
      } catch (lawyerNotificationError) {
        loggingService.logError(lawyerNotificationError as Error, undefined, {
          operation: 'notifyLawyerConsultationCompleted',
          appointmentId,
          lawyerId: appointment.lawyerId
        });
      }

      res.json({
        success: true,
        data: {
          appointment: {
            id: updatedAppointment.id,
            status: updatedAppointment.status,
            completedAt: updatedAppointment.consultationEndedAt,
            actualDuration: updatedAppointment.actualDuration,
            reviewInvitation: updatedSummary.reviewInvitation,
            clientSatisfaction: updatedSummary.clientSatisfaction
          },
          workflow: workflowSummary
        },
        message: 'Consultation completed successfully'
      });

    } catch (error) {
      loggingService.logError(error as Error, req, {
        operation: 'completeConsultation',
        appointmentId: req.params.appointmentId
      });
      res.status(500).json({
        success: false,
        error: 'Failed to complete consultation',
        details: []
      });
    }
  }
);

/**
 * GET /api/bookings/calendar/:userId
 * Returns calendar view of appointments
 */
router.get('/calendar/:userId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const {
        view = 'month',
        date,
        timezone = 'UTC'
      } = req.query;

      const requestingUserId = req.auth!.userId;

      // Check if user can access this calendar
      if (requestingUserId !== userId) {
        // TODO: Add logic for admin access or shared calendars
        return res.status(403).json({
          success: false,
          error: 'Access denied',
          details: ['You can only view your own calendar']
        });
      }

      // Determine user role
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

      // Calculate date range based on view
      const baseDate = date ? new Date(date as string) : new Date();
      let startDate: Date, endDate: Date;

      switch (view) {
        case 'day':
          startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
          endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
          break;
        case 'week':
          const dayOfWeek = baseDate.getDay();
          startDate = new Date(baseDate.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
          endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
        default:
          startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
          endDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0);
          break;
      }

      // Build query based on user role
      const whereClause: any = {
        startTime: {
          gte: startDate,
          lte: endDate
        }
      };

      if (isLawyer) {
        whereClause.lawyerId = user.lawyerProfile!.id;
      } else {
        whereClause.clientId = userId;
      }

      const appointments = await prisma.appointment.findMany({
        where: whereClause,
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
        },
        orderBy: { startTime: 'asc' }
      });

      // Group appointments by date for calendar view
      const calendarData = appointments.reduce((acc: any, appointment) => {
        const dateKey = appointment.startTime.toISOString().split('T')[0];
        if (!acc[dateKey]) {
          acc[dateKey] = [];
        }
        acc[dateKey].push({
          id: appointment.id,
          title: isLawyer
            ? `Consultation with ${appointment.client.firstName} ${appointment.client.lastName}`
            : `Consultation with ${appointment.lawyer.user.firstName} ${appointment.lawyer.user.lastName}`,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
          status: appointment.status,
          consultationType: appointment.consultationType,
          duration: appointment.consultationDuration,
          meetingLink: appointment.meetingLink
        });
        return acc;
      }, {});

      res.json({
        success: true,
        data: {
          view,
          startDate,
          endDate,
          timezone,
          calendarData,
          totalAppointments: appointments.length,
          userRole: isLawyer ? 'lawyer' : 'client'
        }
      });

    } catch (error) {
      console.error('Get calendar error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get calendar data',
        details: []
      });
    }
  }
);

export default router;
