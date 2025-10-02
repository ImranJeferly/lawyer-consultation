// Temporary enum until Prisma client is regenerated
enum ConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}
import prisma from '../config/database';
import { addDays, addMinutes, format, startOfDay, parseISO, isAfter, isBefore, isEqual } from 'date-fns';
import { toZonedTime, fromZonedTime, format as formatTz } from 'date-fns-tz';

interface AvailabilityQuery {
  lawyerId: string;
  startDate?: string; // YYYY-MM-DD format
  endDate?: string;
  consultationType?: ConsultationType;
  duration?: number; // minutes
  timezone?: string;
  includeUnavailable?: boolean;
}

interface TimeSlot {
  startTime: string; // ISO string
  endTime: string; // ISO string
  duration: number; // minutes
  consultationType: ConsultationType;
  basePrice: number;
  totalPrice: number;
  dynamicPricing: {
    sameDayFee?: number;
    peakHourMultiplier?: number;
    weekendMultiplier?: number;
    emergencyFee?: number;
  };
  isAvailable: boolean;
  unavailableReason?: string;
  bufferTime: {
    before: number;
    after: number;
  };
}

interface AvailabilityResponse {
  lawyer: {
    id: string;
    name: string;
    timezone: string;
    hourlyRate: number;
  };
  availableSlots: TimeSlot[];
  unavailablePeriods: Array<{
    startTime: string;
    endTime: string;
    reason: string;
  }>;
  bookingPolicy: {
    minAdvanceHours: number;
    maxAdvanceDays: number;
    allowSameDayBooking: boolean;
    bufferTimeMinutes: number;
  };
  totalSlotsFound: number;
  query: AvailabilityQuery;
}

class AvailabilityCalculationService {

  /**
   * Get lawyer's available time slots for booking
   */
  async getAvailableSlots(query: AvailabilityQuery): Promise<AvailabilityResponse> {
    try {
      const {
        lawyerId,
        startDate = format(new Date(), 'yyyy-MM-dd'),
        endDate = format(addDays(new Date(), 30), 'yyyy-MM-dd'),
        consultationType = ConsultationType.VIDEO,
        duration = 60,
        timezone = 'UTC',
        includeUnavailable = false
      } = query;

      // Get lawyer profile with booking policy
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: {
          user: true,
          bookingPolicy: true,
          availability: true,
          unavailability: true
        }
      });

      if (!lawyer) {
        throw new Error('Lawyer not found');
      }

      if (!lawyer.isVerified) {
        throw new Error('Lawyer not verified - cannot book appointments');
      }

      // Get booking policy or use defaults
      const bookingPolicy = lawyer.bookingPolicy || await this.createDefaultBookingPolicy(lawyerId);

      // Calculate date range
      const startDateObj = parseISO(startDate);
      const endDateObj = parseISO(endDate);
      const lawyerTimezone = lawyer.timezone;

      // Generate time slots
      const availableSlots = await this.generateTimeSlots({
        lawyer,
        startDate: startDateObj,
        endDate: endDateObj,
        consultationType,
        duration,
        clientTimezone: timezone,
        lawyerTimezone,
        bookingPolicy,
        includeUnavailable
      });

      // Get unavailable periods
      const unavailablePeriods = await this.getUnavailablePeriods(
        lawyerId,
        startDateObj,
        endDateObj,
        lawyerTimezone
      );

      return {
        lawyer: {
          id: lawyer.id,
          name: `${lawyer.user.firstName} ${lawyer.user.lastName}`,
          timezone: lawyerTimezone,
          hourlyRate: lawyer.hourlyRate
        },
        availableSlots,
        unavailablePeriods,
        bookingPolicy: {
          minAdvanceHours: bookingPolicy.minAdvanceHours,
          maxAdvanceDays: bookingPolicy.maxAdvanceDays,
          allowSameDayBooking: bookingPolicy.allowSameDayBooking,
          bufferTimeMinutes: bookingPolicy.bufferTimeMinutes
        },
        totalSlotsFound: availableSlots.length,
        query
      };

    } catch (error) {
      console.error('Availability calculation error:', error);
      throw error;
    }
  }

  /**
   * Generate time slots based on lawyer's availability
   */
  private async generateTimeSlots(params: {
    lawyer: any;
    startDate: Date;
    endDate: Date;
    consultationType: ConsultationType;
    duration: number;
    clientTimezone: string;
    lawyerTimezone: string;
    bookingPolicy: any;
    includeUnavailable: boolean;
  }): Promise<TimeSlot[]> {
    const {
      lawyer,
      startDate,
      endDate,
      consultationType,
      duration,
      clientTimezone,
      lawyerTimezone,
      bookingPolicy,
      includeUnavailable
    } = params;

    const slots: TimeSlot[] = [];
    const now = new Date();

    // Get existing appointments to check conflicts
    const existingAppointments = await prisma.appointment.findMany({
      where: {
        lawyerId: lawyer.id,
        startTime: { gte: startDate },
        endTime: { lte: endDate },
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] }
      }
    });

    // Iterate through each day
    let currentDate = startDate;
    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getDay(); // 0=Sunday, 6=Saturday

      // Get lawyer's availability for this day of week
      const dayAvailability = lawyer.availability.filter((avail: any) =>
        avail.dayOfWeek === dayOfWeek && avail.isAvailable
      );

      if (dayAvailability.length === 0) {
        currentDate = addDays(currentDate, 1);
        continue;
      }

      // Check if this date has any unavailability
      const dateUnavailability = await this.getDateUnavailability(
        lawyer.id,
        currentDate,
        lawyerTimezone
      );

      // Generate slots for each availability period
      for (const availability of dayAvailability) {
        const daySlots = await this.generateDaySlots({
          date: currentDate,
          availability,
          duration,
          consultationType,
          lawyer,
          lawyerTimezone,
          clientTimezone,
          bookingPolicy,
          existingAppointments,
          dateUnavailability,
          includeUnavailable,
          now
        });

        slots.push(...daySlots);
      }

      currentDate = addDays(currentDate, 1);
    }

    return slots.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }

  /**
   * Generate time slots for a specific day
   */
  private async generateDaySlots(params: {
    date: Date;
    availability: any;
    duration: number;
    consultationType: ConsultationType;
    lawyer: any;
    lawyerTimezone: string;
    clientTimezone: string;
    bookingPolicy: any;
    existingAppointments: any[];
    dateUnavailability: any[];
    includeUnavailable: boolean;
    now: Date;
  }): Promise<TimeSlot[]> {
    const {
      date,
      availability,
      duration,
      consultationType,
      lawyer,
      lawyerTimezone,
      clientTimezone,
      bookingPolicy,
      existingAppointments,
      dateUnavailability,
      includeUnavailable,
      now
    } = params;

    const slots: TimeSlot[] = [];
    const bufferTime = bookingPolicy.bufferTimeMinutes;

    // Parse availability times
    const [startHour, startMinute] = availability.startTime.split(':').map(Number);
    const [endHour, endMinute] = availability.endTime.split(':').map(Number);

    // Create start and end times in lawyer's timezone
    const dayStart = new Date(date);
    dayStart.setHours(startHour, startMinute, 0, 0);

    const dayEnd = new Date(date);
    dayEnd.setHours(endHour, endMinute, 0, 0);

    // Convert to UTC for consistent processing
    const startTimeUtc = fromZonedTime(dayStart, lawyerTimezone);
    const endTimeUtc = fromZonedTime(dayEnd, lawyerTimezone);

    let currentSlotStart = startTimeUtc;
    const totalSlotDuration = duration + bufferTime; // include buffer time

    while (addMinutes(currentSlotStart, totalSlotDuration) <= endTimeUtc) {
      const slotEnd = addMinutes(currentSlotStart, duration);
      const slotEndWithBuffer = addMinutes(currentSlotStart, totalSlotDuration);

      // Check minimum advance booking time
      const hoursFromNow = (currentSlotStart.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursFromNow < bookingPolicy.minAdvanceHours) {
        currentSlotStart = addMinutes(currentSlotStart, 15); // Move to next 15-minute slot
        continue;
      }

      // Check maximum advance booking time
      const daysFromNow = (currentSlotStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      if (daysFromNow > bookingPolicy.maxAdvanceDays) {
        break;
      }

      // Check for conflicts with existing appointments
      const hasConflict = existingAppointments.some(appointment => {
        const appointmentStart = new Date(appointment.startTime);
        const appointmentEnd = addMinutes(appointmentStart, appointment.bufferTimeBefore + appointment.consultationDuration + appointment.bufferTimeAfter);

        return (
          (currentSlotStart >= appointmentStart && currentSlotStart < appointmentEnd) ||
          (slotEndWithBuffer > appointmentStart && slotEndWithBuffer <= appointmentEnd) ||
          (currentSlotStart <= appointmentStart && slotEndWithBuffer >= appointmentEnd)
        );
      });

      // Check for unavailability
      const hasUnavailability = dateUnavailability.some(unavail => {
        if (unavail.startTime && unavail.endTime) {
          // Specific time unavailability
          const unavailStart = fromZonedTime(
            new Date(`${format(date, 'yyyy-MM-dd')}T${unavail.startTime}`),
            lawyerTimezone
          );
          const unavailEnd = fromZonedTime(
            new Date(`${format(date, 'yyyy-MM-dd')}T${unavail.endTime}`),
            lawyerTimezone
          );
          return currentSlotStart < unavailEnd && slotEndWithBuffer > unavailStart;
        } else {
          // All-day unavailability
          return true;
        }
      });

      // Calculate pricing
      const pricing = this.calculateDynamicPricing({
        slotStart: currentSlotStart,
        duration,
        consultationType,
        baseHourlyRate: lawyer.hourlyRate,
        bookingPolicy,
        isEmergency: consultationType === ConsultationType.EMERGENCY
      });

      // Determine availability
      const isAvailable = !hasConflict && !hasUnavailability;
      let unavailableReason: string | undefined;

      if (hasConflict) {
        unavailableReason = 'Already booked';
      } else if (hasUnavailability) {
        const unavailReason = dateUnavailability.find(u => u.reason)?.reason;
        unavailableReason = unavailReason || 'Lawyer unavailable';
      }

      // Add slot if available or if including unavailable slots
      if (isAvailable || includeUnavailable) {
        // Convert times to client timezone for display
        const clientSlotStart = toZonedTime(currentSlotStart, clientTimezone);
        const clientSlotEnd = toZonedTime(slotEnd, clientTimezone);

        slots.push({
          startTime: clientSlotStart.toISOString(),
          endTime: clientSlotEnd.toISOString(),
          duration,
          consultationType,
          basePrice: pricing.basePrice,
          totalPrice: pricing.totalPrice,
          dynamicPricing: pricing.modifiers,
          isAvailable,
          unavailableReason,
          bufferTime: {
            before: bufferTime,
            after: bufferTime
          }
        });
      }

      // Move to next time slot (15-minute increments)
      currentSlotStart = addMinutes(currentSlotStart, 15);
    }

    return slots;
  }

  /**
   * Calculate dynamic pricing for a time slot
   */
  private calculateDynamicPricing(params: {
    slotStart: Date;
    duration: number;
    consultationType: ConsultationType;
    baseHourlyRate: number;
    bookingPolicy: any;
    isEmergency: boolean;
  }) {
    const { slotStart, duration, consultationType, baseHourlyRate, bookingPolicy, isEmergency } = params;

    // Base price calculation
    const basePrice = (baseHourlyRate * duration) / 60;
    let totalPrice = basePrice;
    const modifiers: any = {};

    // Same-day booking fee
    const hoursFromNow = (slotStart.getTime() - new Date().getTime()) / (1000 * 60 * 60);
    if (hoursFromNow < 24 && bookingPolicy.allowSameDayBooking) {
      modifiers.sameDayFee = bookingPolicy.sameDayBookingFee;
      totalPrice += modifiers.sameDayFee;
    }

    // Peak hour pricing (evenings and weekends)
    const hour = slotStart.getHours();
    const dayOfWeek = slotStart.getDay();

    if ((hour >= 18 || hour <= 8) && (dayOfWeek >= 1 && dayOfWeek <= 5)) {
      // Evening hours on weekdays
      modifiers.peakHourMultiplier = 1.15;
      totalPrice = totalPrice * modifiers.peakHourMultiplier;
    }

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      // Weekend pricing
      modifiers.weekendMultiplier = 1.1;
      totalPrice = totalPrice * modifiers.weekendMultiplier;
    }

    // Emergency consultation fee
    if (isEmergency) {
      modifiers.emergencyFee = basePrice * 0.5; // 50% emergency fee
      totalPrice += modifiers.emergencyFee;
    }

    // Consultation type modifiers
    switch (consultationType) {
      case ConsultationType.PHONE:
        totalPrice = totalPrice * 0.9; // 10% discount for phone
        break;
      case ConsultationType.IN_PERSON:
        totalPrice = totalPrice * 1.2; // 20% premium for in-person
        break;
      case ConsultationType.VIDEO:
      default:
        // No modifier for video (standard)
        break;
    }

    return {
      basePrice: Math.round(basePrice * 100) / 100,
      totalPrice: Math.round(totalPrice * 100) / 100,
      modifiers
    };
  }

  /**
   * Get unavailability periods for a lawyer
   */
  private async getUnavailablePeriods(
    lawyerId: string,
    startDate: Date,
    endDate: Date,
    timezone: string
  ) {
    const unavailabilities = await prisma.lawyerUnavailability.findMany({
      where: {
        lawyerId,
        OR: [
          {
            startDate: { lte: endDate },
            endDate: { gte: startDate }
          }
        ]
      }
    });

    return unavailabilities.map(unavail => ({
      startTime: unavail.startTime
        ? fromZonedTime(new Date(`${format(unavail.startDate, 'yyyy-MM-dd')}T${unavail.startTime}`), timezone).toISOString()
        : fromZonedTime(startOfDay(unavail.startDate), timezone).toISOString(),
      endTime: unavail.endTime
        ? fromZonedTime(new Date(`${format(unavail.endDate, 'yyyy-MM-dd')}T${unavail.endTime}`), timezone).toISOString()
        : fromZonedTime(addDays(startOfDay(unavail.endDate), 1), timezone).toISOString(),
      reason: unavail.reason || 'Unavailable'
    }));
  }

  /**
   * Get unavailability for a specific date
   */
  private async getDateUnavailability(lawyerId: string, date: Date, timezone: string) {
    return await prisma.lawyerUnavailability.findMany({
      where: {
        lawyerId,
        startDate: { lte: date },
        endDate: { gte: date }
      }
    });
  }

  /**
   * Create default booking policy for lawyer
   */
  private async createDefaultBookingPolicy(lawyerId: string) {
    return await prisma.bookingPolicy.create({
      data: {
        lawyerId,
        minAdvanceHours: 24,
        maxAdvanceDays: 30,
        allowSameDayBooking: false,
        sameDayBookingFee: 50,
        freeCancellationHours: 24,
        cancellationFeePercentage: 50,
        noCancellationHours: 2,
        freeReschedulingHours: 24,
        maxReschedulingCount: 2,
        reschedulingFee: 25,
        bufferTimeMinutes: 15,
        preparationTimeMinutes: 10,
        followupTimeMinutes: 5,
        requirePaymentUpfront: true,
        allowPartialPayment: false,
        partialPaymentPercentage: 50,
        platformFeePercentage: 15.0,
        minimumPlatformFee: 5.0
      }
    });
  }

  /**
   * Check if a specific time slot is available
   */
  async isSlotAvailable(
    lawyerId: string,
    startTime: Date,
    duration: number,
    consultationType: ConsultationType
  ): Promise<{
    isAvailable: boolean;
    conflictReason?: string;
    pricing?: any;
  }> {
    try {
      const endTime = addMinutes(startTime, duration);

      // Check existing appointments
      const conflictingAppointment = await prisma.appointment.findFirst({
        where: {
          lawyerId,
          status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
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

      if (conflictingAppointment) {
        return {
          isAvailable: false,
          conflictReason: 'Time slot already booked'
        };
      }

      // Check unavailability
      const dateUnavailability = await this.getDateUnavailability(
        lawyerId,
        startTime,
        'UTC' // Will be converted properly in the actual method
      );

      if (dateUnavailability.length > 0) {
        return {
          isAvailable: false,
          conflictReason: 'Lawyer unavailable during this time'
        };
      }

      // Get lawyer for pricing calculation
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { bookingPolicy: true }
      });

      if (!lawyer) {
        return {
          isAvailable: false,
          conflictReason: 'Lawyer not found'
        };
      }

      const pricing = this.calculateDynamicPricing({
        slotStart: startTime,
        duration,
        consultationType,
        baseHourlyRate: lawyer.hourlyRate,
        bookingPolicy: lawyer.bookingPolicy,
        isEmergency: consultationType === ConsultationType.EMERGENCY
      });

      return {
        isAvailable: true,
        pricing
      };

    } catch (error) {
      console.error('Slot availability check error:', error);
      return {
        isAvailable: false,
        conflictReason: 'Error checking availability'
      };
    }
  }
}

export default new AvailabilityCalculationService();