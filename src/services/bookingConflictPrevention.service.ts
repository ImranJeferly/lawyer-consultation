// Temporary enum until Prisma client is regenerated
enum ConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}
import prisma from '../config/database';
import { addMinutes, isAfter, isBefore } from 'date-fns';
import availabilityCalculationService from './availabilityCalculation.service';

interface BookingLockParams {
  lawyerId: string;
  startTime: Date;
  endTime: Date;
  consultationType: ConsultationType;
  userId: string;
  durationMinutes?: number; // minutes to hold the lock
}

interface BookingValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  conflictDetails?: {
    type: 'appointment' | 'unavailability' | 'booking_policy' | 'lawyer_status';
    details: string;
    conflictingAppointment?: any;
  };
}

interface ConflictCheckResult {
  hasConflict: boolean;
  conflictType?: 'double_booking' | 'unavailability' | 'buffer_overlap' | 'policy_violation';
  conflictDetails?: string;
  suggestedAlternatives?: Array<{
    startTime: Date;
    endTime: Date;
    reason: string;
  }>;
}

class BookingConflictPreventionService {

  /**
   * Create a booking lock to prevent race conditions
   */
  async createBookingLock(params: BookingLockParams): Promise<{
    success: boolean;
    lockId?: string;
    error?: string;
  }> {
    try {
      const { lawyerId, startTime, endTime, consultationType, userId, durationMinutes = 10 } = params;

      const expiresAt = addMinutes(new Date(), durationMinutes);

      // Clean up expired locks first
      await this.cleanupExpiredLocks();

      // Check if there's already an active lock for this time slot
      const existingLock = await prisma.bookingLock.findFirst({
        where: {
          lawyerId,
          consultationType,
          isActive: true,
          OR: [
            {
              AND: [
                { startTime: { lte: startTime } },
                { endTime: { gt: startTime } }
              ]
            },
            {
              AND: [
                { startTime: { lt: endTime } },
                { endTime: { gte: endTime } }
              ]
            },
            {
              AND: [
                { startTime: { gte: startTime } },
                { endTime: { lte: endTime } }
              ]
            }
          ]
        }
      });

      if (existingLock && existingLock.lockedBy !== userId) {
        return {
          success: false,
          error: 'Time slot is currently being booked by another user'
        };
      }

      // Create new lock or extend existing one
      const lock = await prisma.bookingLock.upsert({
        where: {
          id: existingLock?.id || 'non-existent-id'
        },
        update: {
          expiresAt,
          isActive: true
        },
        create: {
          lawyerId,
          startTime,
          endTime,
          consultationType,
          lockedBy: userId,
          expiresAt,
          isActive: true
        }
      });

      return {
        success: true,
        lockId: lock.id
      };

    } catch (error) {
      console.error('Booking lock creation error:', error);
      return {
        success: false,
        error: 'Failed to create booking lock'
      };
    }
  }

  /**
   * Release a booking lock
   */
  async releaseBookingLock(lockId: string): Promise<void> {
    try {
      await prisma.bookingLock.update({
        where: { id: lockId },
        data: { isActive: false }
      });
    } catch (error) {
      console.error('Lock release error:', error);
    }
  }

  /**
   * Clean up expired booking locks
   */
  async cleanupExpiredLocks(): Promise<void> {
    try {
      await prisma.bookingLock.updateMany({
        where: {
          expiresAt: { lt: new Date() },
          isActive: true
        },
        data: { isActive: false }
      });
    } catch (error) {
      console.error('Lock cleanup error:', error);
    }
  }

  /**
   * Comprehensive booking validation
   */
  async validateBooking(params: {
    lawyerId: string;
    clientId: string;
    startTime: Date;
    endTime: Date;
    consultationType: ConsultationType;
    duration: number;
    clientTimezone?: string;
    lawyerTimezone?: string;
  }): Promise<BookingValidation> {
    const { lawyerId, clientId, startTime, endTime, consultationType, duration } = params;
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // 1. Check if lawyer exists and is verified
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: {
          user: true,
          bookingPolicy: true
        }
      });

      if (!lawyer) {
        errors.push('Lawyer not found');
        return { isValid: false, errors, warnings };
      }

      if (!lawyer.isVerified) {
        errors.push('Lawyer is not verified and cannot accept bookings');
        return {
          isValid: false,
          errors,
          warnings,
          conflictDetails: {
            type: 'lawyer_status',
            details: 'Lawyer verification required'
          }
        };
      }

      // 2. Check if client exists
      const client = await prisma.user.findUnique({
        where: { id: clientId }
      });

      if (!client) {
        errors.push('Client not found');
        return { isValid: false, errors, warnings };
      }

      // 3. Validate consultation duration rules
      if (duration < (lawyer.minimumConsultationDuration || 15)) {
        errors.push(`Minimum consultation duration is ${lawyer.minimumConsultationDuration || 15} minutes`);
      }

      if (duration > (lawyer.maximumConsultationDuration || 240)) {
        errors.push(`Maximum consultation duration is ${lawyer.maximumConsultationDuration || 240} minutes`);
      }

      if (duration % 15 !== 0) {
        errors.push('Consultation duration must be in 15-minute increments');
      }

      // 3. Validate time slot basics
      const now = new Date();
      if (startTime <= now) {
        errors.push('Appointment time must be in the future');
      }

      if (startTime >= endTime) {
        errors.push('Start time must be before end time');
      }

      const calculatedDuration = (endTime.getTime() - startTime.getTime()) / (1000 * 60);
      if (Math.abs(calculatedDuration - duration) > 1) {
        errors.push('Duration mismatch between start/end times and specified duration');
      }

      // 4. Check booking policy constraints
      const bookingPolicy = lawyer.bookingPolicy;
      if (bookingPolicy) {
        const hoursFromNow = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (hoursFromNow < bookingPolicy.minAdvanceHours) {
          if (!bookingPolicy.allowSameDayBooking) {
            errors.push(`Minimum advance booking time is ${bookingPolicy.minAdvanceHours} hours`);
          } else {
            warnings.push(`Same-day booking fee of $${bookingPolicy.sameDayBookingFee} will apply`);
          }
        }

        const daysFromNow = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (daysFromNow > bookingPolicy.maxAdvanceDays) {
          errors.push(`Cannot book more than ${bookingPolicy.maxAdvanceDays} days in advance`);
        }
      }

      // 5. Check for conflicts
      const conflictCheck = await this.checkForConflicts({
        lawyerId,
        startTime,
        endTime,
        consultationType,
        bufferTime: bookingPolicy?.bufferTimeMinutes || 15
      });

      if (conflictCheck.hasConflict) {
        errors.push(conflictCheck.conflictDetails || 'Time slot conflict detected');

        return {
          isValid: false,
          errors,
          warnings,
          conflictDetails: {
            type: 'appointment',
            details: conflictCheck.conflictDetails || 'Scheduling conflict',
            conflictingAppointment: conflictCheck.conflictType === 'double_booking' ? true : undefined
          }
        };
      }

      // 6. Check client's booking limits (prevent spam)
      const clientBookingsToday = await prisma.appointment.count({
        where: {
          clientId,
          startTime: {
            gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
            lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
          },
          status: { in: ['PENDING', 'CONFIRMED'] }
        }
      });

      if (clientBookingsToday >= 3) {
        warnings.push('You have reached the daily booking limit of 3 appointments');
      }

      // 7. Check lawyer availability using the availability service
      const slotAvailability = await availabilityCalculationService.isSlotAvailable(
        lawyerId,
        startTime,
        duration,
        consultationType
      );

      if (!slotAvailability.isAvailable) {
        errors.push(slotAvailability.conflictReason || 'Time slot not available');
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };

    } catch (error) {
      console.error('Booking validation error:', error);
      return {
        isValid: false,
        errors: ['Validation failed due to system error'],
        warnings
      };
    }
  }

  /**
   * Check for specific conflicts with existing appointments and unavailability
   */
  async checkForConflicts(params: {
    lawyerId: string;
    startTime: Date;
    endTime: Date;
    consultationType: ConsultationType;
    bufferTime: number;
    excludeAppointmentId?: string;
  }): Promise<ConflictCheckResult> {
    const { lawyerId, startTime, endTime, consultationType, bufferTime, excludeAppointmentId } = params;

    try {
      // Add buffer time to check for conflicts
      const startTimeWithBuffer = addMinutes(startTime, -bufferTime);
      const endTimeWithBuffer = addMinutes(endTime, bufferTime);

      // Check for existing appointments
      const conflictingAppointments = await prisma.appointment.findMany({
        where: {
          lawyerId,
          id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
          status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          OR: [
            {
              AND: [
                { startTime: { lte: startTimeWithBuffer } },
                { endTime: { gt: startTimeWithBuffer } }
              ]
            },
            {
              AND: [
                { startTime: { lt: endTimeWithBuffer } },
                { endTime: { gte: endTimeWithBuffer } }
              ]
            },
            {
              AND: [
                { startTime: { gte: startTimeWithBuffer } },
                { endTime: { lte: endTimeWithBuffer } }
              ]
            }
          ]
        },
        include: {
          client: true
        }
      });

      if (conflictingAppointments.length > 0) {
        const conflict = conflictingAppointments[0];
        return {
          hasConflict: true,
          conflictType: 'double_booking',
          conflictDetails: `Conflicts with existing appointment from ${conflict.startTime.toISOString()} to ${conflict.endTime.toISOString()}`,
          suggestedAlternatives: await this.findAlternativeSlots(lawyerId, startTime, endTime, consultationType)
        };
      }

      // Check for unavailability periods
      const unavailabilityConflicts = await prisma.lawyerUnavailability.findMany({
        where: {
          lawyerId,
          startDate: { lte: endTime },
          endDate: { gte: startTime }
        }
      });

      for (const unavail of unavailabilityConflicts) {
        // Check if time-specific unavailability conflicts
        if (unavail.startTime && unavail.endTime) {
          const unavailStart = new Date(`${unavail.startDate.toISOString().split('T')[0]}T${unavail.startTime}`);
          const unavailEnd = new Date(`${unavail.endDate.toISOString().split('T')[0]}T${unavail.endTime}`);

          if (startTime < unavailEnd && endTime > unavailStart) {
            return {
              hasConflict: true,
              conflictType: 'unavailability',
              conflictDetails: `Lawyer unavailable: ${unavail.reason || 'No reason specified'}`
            };
          }
        } else {
          // All-day unavailability
          return {
            hasConflict: true,
            conflictType: 'unavailability',
            conflictDetails: `Lawyer unavailable all day: ${unavail.reason || 'No reason specified'}`
          };
        }
      }

      return { hasConflict: false };

    } catch (error) {
      console.error('Conflict check error:', error);
      return {
        hasConflict: true,
        conflictType: 'buffer_overlap',
        conflictDetails: 'Error checking for conflicts'
      };
    }
  }

  /**
   * Find alternative time slots when there's a conflict
   */
  private async findAlternativeSlots(
    lawyerId: string,
    originalStart: Date,
    originalEnd: Date,
    consultationType: ConsultationType
  ): Promise<Array<{ startTime: Date; endTime: Date; reason: string; }>> {
    try {
      const duration = (originalEnd.getTime() - originalStart.getTime()) / (1000 * 60);
      const availabilityQuery = {
        lawyerId,
        startDate: originalStart.toISOString().split('T')[0],
        endDate: addMinutes(originalStart, 7 * 24 * 60).toISOString().split('T')[0], // Next 7 days
        consultationType,
        duration,
        timezone: 'UTC'
      };

      const availability = await availabilityCalculationService.getAvailableSlots(availabilityQuery);

      return availability.availableSlots
        .filter(slot => slot.isAvailable)
        .slice(0, 3) // Return top 3 alternatives
        .map(slot => ({
          startTime: new Date(slot.startTime),
          endTime: new Date(slot.endTime),
          reason: 'Alternative available slot'
        }));

    } catch (error) {
      console.error('Alternative slots search error:', error);
      return [];
    }
  }

  /**
   * Check if a time slot can be rescheduled to
   */
  async validateReschedule(params: {
    appointmentId: string;
    newStartTime: Date;
    newEndTime: Date;
  }): Promise<BookingValidation> {
    try {
      const { appointmentId, newStartTime, newEndTime } = params;

      // Get existing appointment
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          lawyer: {
            include: { bookingPolicy: true }
          }
        }
      });

      if (!appointment) {
        return {
          isValid: false,
          errors: ['Appointment not found'],
          warnings: []
        };
      }

      // Check reschedule policy
      const policy = appointment.lawyer.bookingPolicy;
      if (policy) {
        const hoursUntilOriginal = (appointment.startTime.getTime() - new Date().getTime()) / (1000 * 60 * 60);

        if (hoursUntilOriginal < policy.freeReschedulingHours) {
          return {
            isValid: false,
            errors: [`Reschedule fee of $${policy.reschedulingFee} applies for changes within ${policy.freeReschedulingHours} hours`],
            warnings: []
          };
        }

        if (appointment.rescheduleCount >= policy.maxReschedulingCount) {
          return {
            isValid: false,
            errors: [`Maximum reschedule limit of ${policy.maxReschedulingCount} reached`],
            warnings: []
          };
        }
      }

      // Validate new time slot
      return await this.validateBooking({
        lawyerId: appointment.lawyerId,
        clientId: appointment.clientId,
        startTime: newStartTime,
        endTime: newEndTime,
        consultationType: appointment.consultationType as ConsultationType,
        duration: appointment.consultationDuration
      });

    } catch (error) {
      console.error('Reschedule validation error:', error);
      return {
        isValid: false,
        errors: ['Reschedule validation failed'],
        warnings: []
      };
    }
  }

  /**
   * Atomic booking creation with conflict prevention
   */
  async atomicBookingCreation(bookingData: {
    lawyerId: string;
    clientId: string;
    startTime: Date;
    endTime: Date;
    consultationType: ConsultationType;
    duration: number;
    totalAmount: number;
    clientTimeZone: string;
    lawyerTimeZone: string;
    bufferTimeMinutes: number;
    clientNotes?: string;
    lockId?: string;
  }): Promise<{
    success: boolean;
    appointmentId?: string;
    error?: string;
  }> {
    const transaction = await prisma.$transaction(async (tx) => {
      try {
        // Final validation within transaction
        const validation = await this.validateBooking(bookingData);
        if (!validation.isValid) {
          throw new Error(validation.errors.join(', '));
        }

        // Create the appointment
        const appointment = await tx.appointment.create({
          data: {
            clientId: bookingData.clientId,
            lawyerId: bookingData.lawyerId,
            startTime: bookingData.startTime,
            endTime: bookingData.endTime,
            consultationType: bookingData.consultationType,
            consultationDuration: bookingData.duration,
            baseAmount: bookingData.totalAmount * 0.85, // Assuming 15% platform fee
            platformFee: bookingData.totalAmount * 0.15,
            totalAmount: bookingData.totalAmount,
            timeZone: bookingData.lawyerTimeZone,
            clientTimeZone: bookingData.clientTimeZone,
            lawyerTimeZone: bookingData.lawyerTimeZone,
            bufferTimeBefore: bookingData.bufferTimeMinutes,
            bufferTimeAfter: bookingData.bufferTimeMinutes,
            clientNotes: bookingData.clientNotes,
            status: 'PENDING'
          }
        });

        // Release the booking lock if provided
        if (bookingData.lockId) {
          await tx.bookingLock.update({
            where: { id: bookingData.lockId },
            data: { isActive: false }
          });
        }

        return {
          success: true,
          appointmentId: appointment.id
        };

      } catch (error) {
        throw error;
      }
    });

    return transaction;
  }
}

export default new BookingConflictPreventionService();