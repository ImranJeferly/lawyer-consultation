import prisma from '../config/database';
import { addHours, isWeekend, getHours } from 'date-fns';

enum ConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}

enum Currency {
  AZN = 'AZN',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  TRY = 'TRY'
}

interface PricingModifiers {
  sameDayFee: number;
  premiumTimeFee: number;
  weekendFee: number;
  urgentFee: number;
  consultationTypeFee: number;
}

interface PricingCalculation {
  baseAmount: number;
  modifiers: PricingModifiers;
  subtotal: number;
  platformFee: number;
  taxes: number;
  totalAmount: number;
  lawyerReceives: number;
  platformKeeps: number;
  currency: Currency;
  breakdown: {
    baseRate: number;
    duration: number;
    modifierDetails: string[];
    platformFeePercentage: number;
    taxPercentage: number;
  };
}

interface CostCalculationParams {
  lawyerId: string;
  duration: number; // minutes
  appointmentTime: Date;
  consultationType: ConsultationType;
  isUrgent?: boolean;
  clientTimezone?: string;
  discountCode?: string;
  promoCode?: string;
}

class PaymentCalculationService {

  /**
   * Calculate total consultation cost with all modifiers
   */
  async calculateConsultationCost(params: CostCalculationParams): Promise<PricingCalculation> {
    try {
      const {
        lawyerId,
        duration,
        appointmentTime,
        consultationType,
        isUrgent = false,
        clientTimezone = 'UTC'
      } = params;

      // Get lawyer profile with pricing and policy info
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: {
          user: true,
          bookingPolicy: true
        }
      });

      if (!lawyer) {
        throw new Error('Lawyer not found');
      }

      if (!lawyer.isVerified) {
        throw new Error('Lawyer is not verified and cannot accept bookings');
      }

      // Base cost calculation
      const baseAmount = (lawyer.hourlyRate * duration) / 60;
      let totalAmount = baseAmount;

      const modifiers: PricingModifiers = {
        sameDayFee: 0,
        premiumTimeFee: 0,
        weekendFee: 0,
        urgentFee: 0,
        consultationTypeFee: 0
      };

      const modifierDetails: string[] = [];

      // Calculate time-based modifiers
      const now = new Date();
      const hoursUntilAppointment = (appointmentTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      // Same-day booking fee
      if (hoursUntilAppointment < 24) {
        const policy = lawyer.bookingPolicy;
        if (policy?.allowSameDayBooking) {
          const sameDayFee = Math.max(policy.sameDayBookingFee, baseAmount * 0.25); // 25% or minimum fee
          modifiers.sameDayFee = sameDayFee;
          totalAmount += sameDayFee;
          modifierDetails.push(`Same-day booking fee: +${sameDayFee.toFixed(2)} AZN`);
        }
      }

      // Premium time pricing (6 PM - 9 PM weekdays)
      const appointmentHour = getHours(appointmentTime);
      const isWeekday = !isWeekend(appointmentTime);

      if (isWeekday && appointmentHour >= 18 && appointmentHour <= 21) {
        const premiumMultiplier = 1.20; // 20% premium
        const premiumFee = baseAmount * (premiumMultiplier - 1);
        modifiers.premiumTimeFee = premiumFee;
        totalAmount += premiumFee;
        modifierDetails.push(`Premium time (6-9 PM): +${premiumFee.toFixed(2)} AZN`);
      }

      // Weekend pricing
      if (isWeekend(appointmentTime)) {
        const weekendMultiplier = 1.15; // 15% weekend premium
        const weekendFee = baseAmount * (weekendMultiplier - 1);
        modifiers.weekendFee = weekendFee;
        totalAmount += weekendFee;
        modifierDetails.push(`Weekend consultation: +${weekendFee.toFixed(2)} AZN`);
      }

      // Urgent consultation fee
      if (isUrgent || consultationType === ConsultationType.EMERGENCY) {
        const urgentFee = baseAmount * 0.5; // 50% urgent fee
        modifiers.urgentFee = urgentFee;
        totalAmount += urgentFee;
        modifierDetails.push(`Urgent consultation: +${urgentFee.toFixed(2)} AZN`);
      }

      // Consultation type modifiers
      let consultationTypeMultiplier = 1.0;
      switch (consultationType) {
        case ConsultationType.PHONE:
          consultationTypeMultiplier = 0.9; // 10% discount
          modifiers.consultationTypeFee = baseAmount * (consultationTypeMultiplier - 1);
          modifierDetails.push(`Phone consultation: ${modifiers.consultationTypeFee.toFixed(2)} AZN`);
          break;
        case ConsultationType.IN_PERSON:
          const inPersonFee = 25; // Fixed 25 AZN fee
          modifiers.consultationTypeFee = inPersonFee;
          totalAmount += inPersonFee;
          modifierDetails.push(`In-person consultation: +${inPersonFee.toFixed(2)} AZN`);
          break;
        case ConsultationType.VIDEO:
        default:
          // No modifier for video (standard)
          break;
      }

      // Apply phone consultation discount after other calculations
      if (consultationType === ConsultationType.PHONE) {
        totalAmount = totalAmount * consultationTypeMultiplier;
      }

      const subtotal = totalAmount;

      // Platform fee calculation
      const policy = lawyer.bookingPolicy;
      const platformFeePercentage = policy?.platformFeePercentage || 15.0;
      const minimumPlatformFee = policy?.minimumPlatformFee || 5.0;
      const maximumPlatformFee = policy?.maximumPlatformFee;

      let platformFee = subtotal * (platformFeePercentage / 100);
      platformFee = Math.max(platformFee, minimumPlatformFee);

      if (maximumPlatformFee) {
        platformFee = Math.min(platformFee, maximumPlatformFee);
      }

      // Tax calculation (Azerbaijan tax rate - placeholder, should be configurable)
      const taxPercentage = 18.0; // 18% VAT in Azerbaijan
      const taxes = (subtotal + platformFee) * (taxPercentage / 100);

      const finalTotalAmount = subtotal + platformFee + taxes;
      const lawyerReceives = subtotal - (subtotal * (platformFeePercentage / 100));
      const platformKeeps = platformFee + taxes;

      return {
        baseAmount: Math.round(baseAmount * 100) / 100,
        modifiers: {
          sameDayFee: Math.round(modifiers.sameDayFee * 100) / 100,
          premiumTimeFee: Math.round(modifiers.premiumTimeFee * 100) / 100,
          weekendFee: Math.round(modifiers.weekendFee * 100) / 100,
          urgentFee: Math.round(modifiers.urgentFee * 100) / 100,
          consultationTypeFee: Math.round(modifiers.consultationTypeFee * 100) / 100
        },
        subtotal: Math.round(subtotal * 100) / 100,
        platformFee: Math.round(platformFee * 100) / 100,
        taxes: Math.round(taxes * 100) / 100,
        totalAmount: Math.round(finalTotalAmount * 100) / 100,
        lawyerReceives: Math.round(lawyerReceives * 100) / 100,
        platformKeeps: Math.round(platformKeeps * 100) / 100,
        currency: Currency.AZN,
        breakdown: {
          baseRate: lawyer.hourlyRate,
          duration,
          modifierDetails,
          platformFeePercentage,
          taxPercentage
        }
      };

    } catch (error) {
      console.error('Payment calculation error:', error);
      throw error;
    }
  }

  /**
   * Validate pricing against lawyer's rates and policies
   */
  async validatePricing(lawyerId: string, calculatedAmount: number): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    try {
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { bookingPolicy: true }
      });

      if (!lawyer) {
        return {
          isValid: false,
          errors: ['Lawyer not found'],
          warnings: []
        };
      }

      const errors: string[] = [];
      const warnings: string[] = [];

      // Check minimum consultation amount
      const minimumAmount = lawyer.hourlyRate * 0.5; // Minimum 30 minutes
      if (calculatedAmount < minimumAmount) {
        errors.push(`Amount below minimum consultation fee of ${minimumAmount.toFixed(2)} AZN`);
      }

      // Check maximum consultation amount (safety check)
      const maximumAmount = lawyer.hourlyRate * 4; // Maximum 4 hours
      if (calculatedAmount > maximumAmount) {
        warnings.push(`Amount exceeds typical consultation range of ${maximumAmount.toFixed(2)} AZN`);
      }

      // Check if lawyer is accepting bookings
      if (!lawyer.isVerified) {
        errors.push('Lawyer is not verified and cannot accept bookings');
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };

    } catch (error) {
      console.error('Pricing validation error:', error);
      return {
        isValid: false,
        errors: ['Pricing validation failed'],
        warnings: []
      };
    }
  }

  /**
   * Calculate consultation cost for multiple lawyers (comparison)
   */
  async calculateBulkConsultationCosts(params: {
    lawyerIds: string[];
    duration: number;
    appointmentTime: Date;
    consultationType: ConsultationType;
    isUrgent?: boolean;
  }): Promise<Array<{
    lawyerId: string;
    lawyerName: string;
    pricing: PricingCalculation;
    isAvailable: boolean;
  }>> {
    try {
      const { lawyerIds, duration, appointmentTime, consultationType, isUrgent } = params;

      const results = await Promise.allSettled(
        lawyerIds.map(async (lawyerId) => {
          const pricing = await this.calculateConsultationCost({
            lawyerId,
            duration,
            appointmentTime,
            consultationType,
            isUrgent
          });

          const lawyer = await prisma.lawyerProfile.findUnique({
            where: { id: lawyerId },
            include: { user: true }
          });

          return {
            lawyerId,
            lawyerName: lawyer ? `${lawyer.user.firstName} ${lawyer.user.lastName}` : 'Unknown',
            pricing,
            isAvailable: lawyer?.isVerified || false
          };
        })
      );

      return results
        .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
        .map(result => result.value)
        .sort((a, b) => a.pricing.totalAmount - b.pricing.totalAmount);

    } catch (error) {
      console.error('Bulk calculation error:', error);
      throw error;
    }
  }

  /**
   * Calculate pricing with promotional codes or discounts
   */
  async calculateWithDiscounts(params: CostCalculationParams & {
    promoCode?: string;
    clientDiscountPercentage?: number;
    isFirstTimeClient?: boolean;
  }): Promise<PricingCalculation & {
    originalTotal: number;
    discountAmount: number;
    discountReason: string;
  }> {
    try {
      // First calculate base pricing
      const basePricing = await this.calculateConsultationCost(params);
      let discountAmount = 0;
      let discountReason = '';

      // Apply first-time client discount
      if (params.isFirstTimeClient) {
        discountAmount = basePricing.totalAmount * 0.1; // 10% first-time discount
        discountReason = 'First-time client discount (10%)';
      }

      // Apply client-specific discount
      if (params.clientDiscountPercentage && params.clientDiscountPercentage > 0) {
        const clientDiscount = basePricing.totalAmount * (params.clientDiscountPercentage / 100);
        if (clientDiscount > discountAmount) {
          discountAmount = clientDiscount;
          discountReason = `Client discount (${params.clientDiscountPercentage}%)`;
        }
      }

      // TODO: Implement promo code logic
      if (params.promoCode) {
        // Check promo code validity and apply discount
        // This would involve a promo codes table and validation logic
      }

      const finalTotalAmount = Math.max(0, basePricing.totalAmount - discountAmount);

      return {
        ...basePricing,
        totalAmount: Math.round(finalTotalAmount * 100) / 100,
        originalTotal: basePricing.totalAmount,
        discountAmount: Math.round(discountAmount * 100) / 100,
        discountReason
      };

    } catch (error) {
      console.error('Discount calculation error:', error);
      throw error;
    }
  }

  /**
   * Get platform fee breakdown for transparency
   */
  async getPlatformFeeBreakdown(lawyerId: string): Promise<{
    platformFeePercentage: number;
    minimumFee: number;
    maximumFee?: number;
    description: string;
    whatItCovers: string[];
  }> {
    try {
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { bookingPolicy: true }
      });

      if (!lawyer) {
        throw new Error('Lawyer not found');
      }

      const policy = lawyer.bookingPolicy;

      return {
        platformFeePercentage: policy?.platformFeePercentage || 15.0,
        minimumFee: policy?.minimumPlatformFee || 5.0,
        maximumFee: policy?.maximumPlatformFee || undefined,
        description: 'Platform service fee for consultation management',
        whatItCovers: [
          'Payment processing and security',
          'Video consultation platform',
          'Appointment scheduling and reminders',
          'Document sharing and storage',
          'Customer support',
          'Dispute resolution',
          'Legal compliance and insurance'
        ]
      };

    } catch (error) {
      console.error('Platform fee breakdown error:', error);
      throw error;
    }
  }

  /**
   * Calculate refund amount based on cancellation timing and policy
   */
  async calculateRefundAmount(appointmentId: string, cancellationTime: Date): Promise<{
    originalAmount: number;
    refundAmount: number;
    cancellationFee: number;
    platformFeeRefund: number;
    taxRefund: number;
    refundReason: string;
    isEligible: boolean;
    refundPercentage: number;
  }> {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          lawyer: {
            include: { bookingPolicy: true }
          }
        }
      });

      if (!appointment) {
        throw new Error('Appointment not found');
      }

      const policy = appointment.lawyer.bookingPolicy;
      const hoursUntilAppointment = (appointment.startTime.getTime() - cancellationTime.getTime()) / (1000 * 60 * 60);

      let refundPercentage = 0;
      let refundReason = '';

      if (!policy) {
        // Default policy: 24 hours free cancellation
        if (hoursUntilAppointment >= 24) {
          refundPercentage = 100;
          refundReason = 'Free cancellation (24+ hours notice)';
        } else if (hoursUntilAppointment >= 2) {
          refundPercentage = 25;
          refundReason = 'Late cancellation fee applied';
        } else {
          refundPercentage = 0;
          refundReason = 'No refund (less than 2 hours notice)';
        }
      } else {
        // Apply lawyer's specific cancellation policy
        if (hoursUntilAppointment >= policy.freeCancellationHours) {
          refundPercentage = 100;
          refundReason = `Free cancellation (${policy.freeCancellationHours}+ hours notice)`;
        } else if (hoursUntilAppointment >= policy.noCancellationHours) {
          refundPercentage = 100 - policy.cancellationFeePercentage;
          refundReason = `Cancellation fee applied (${policy.cancellationFeePercentage}%)`;
        } else {
          refundPercentage = 0;
          refundReason = `No refund (less than ${policy.noCancellationHours} hours notice)`;
        }
      }

      const originalAmount = appointment.totalAmount;
      const baseRefundAmount = originalAmount * (refundPercentage / 100);

      // Calculate component refunds
      const platformFeeRefund = hoursUntilAppointment >= 24 ? appointment.platformFee : 0;
      const taxRefund = baseRefundAmount * 0.18; // Proportional tax refund

      const finalRefundAmount = baseRefundAmount;
      const cancellationFee = originalAmount - finalRefundAmount;

      return {
        originalAmount: Math.round(originalAmount * 100) / 100,
        refundAmount: Math.round(finalRefundAmount * 100) / 100,
        cancellationFee: Math.round(cancellationFee * 100) / 100,
        platformFeeRefund: Math.round(platformFeeRefund * 100) / 100,
        taxRefund: Math.round(taxRefund * 100) / 100,
        refundReason,
        isEligible: refundPercentage > 0,
        refundPercentage
      };

    } catch (error) {
      console.error('Refund calculation error:', error);
      throw error;
    }
  }

  /**
   * Convert amount between currencies
   */
  async convertCurrency(amount: number, fromCurrency: Currency, toCurrency: Currency): Promise<{
    originalAmount: number;
    convertedAmount: number;
    exchangeRate: number;
    fromCurrency: Currency;
    toCurrency: Currency;
    lastUpdated: Date;
  }> {
    try {
      if (fromCurrency === toCurrency) {
        return {
          originalAmount: amount,
          convertedAmount: amount,
          exchangeRate: 1,
          fromCurrency,
          toCurrency,
          lastUpdated: new Date()
        };
      }

      // Get exchange rate from database
      const exchangeRate = await prisma.exchangeRate.findUnique({
        where: {
          fromCurrency_toCurrency: {
            fromCurrency,
            toCurrency
          }
        }
      });

      if (!exchangeRate) {
        throw new Error(`Exchange rate not found for ${fromCurrency} to ${toCurrency}`);
      }

      const convertedAmount = amount * exchangeRate.rate;

      return {
        originalAmount: Math.round(amount * 100) / 100,
        convertedAmount: Math.round(convertedAmount * 100) / 100,
        exchangeRate: exchangeRate.rate,
        fromCurrency,
        toCurrency,
        lastUpdated: exchangeRate.updatedAt
      };

    } catch (error) {
      console.error('Currency conversion error:', error);
      throw error;
    }
  }
}

export default new PaymentCalculationService();