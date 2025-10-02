import prisma from '../config/database';
import { Currency, ConsultationType } from '@prisma/client';

// Temporary enum until Prisma client is regenerated
enum TempConsultationType {
  VIDEO = 'VIDEO',
  PHONE = 'PHONE',
  IN_PERSON = 'IN_PERSON',
  EMERGENCY = 'EMERGENCY'
}

interface PricingModifiers {
  sameDayFee: number;
  premiumTimeFee: number;
  weekendFee: number;
  urgentFee: number;
  consultationTypeFee: number;
  experiencePremium: number;
  locationFee: number;
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
  currency: string;
  breakdown: string[];
}

interface ExchangeRates {
  [key: string]: number;
}

class PricingEngineService {
  private readonly PLATFORM_FEE_PERCENTAGE = 0.15; // 15%
  private readonly TAX_RATE = 0.18; // 18% VAT for Azerbaijan
  private readonly MIN_SAME_DAY_FEE = 50; // AZN
  private readonly EXPERIENCE_TIERS = {
    junior: 0, // 0-2 years
    mid: 0.1, // 2-5 years (10% premium)
    senior: 0.2, // 5-10 years (20% premium)
    expert: 0.35 // 10+ years (35% premium)
  };

  /**
   * Calculate comprehensive consultation pricing
   */
  async calculateConsultationCost(
    lawyerId: string,
    duration: number, // in minutes
    appointmentTime: Date,
    consultationType: TempConsultationType,
    isUrgent: boolean = false,
    clientLocation?: string,
    currency: string = 'AZN'
  ): Promise<PricingCalculation> {
    try {
      // Get lawyer profile with pricing info
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

      // Base calculation
      const hourlyRate = lawyer.hourlyRate || 100; // default rate
      const baseAmount = hourlyRate * (duration / 60);

      // Initialize modifiers
      const modifiers: PricingModifiers = {
        sameDayFee: 0,
        premiumTimeFee: 0,
        weekendFee: 0,
        urgentFee: 0,
        consultationTypeFee: 0,
        experiencePremium: 0,
        locationFee: 0
      };

      const breakdown: string[] = [];
      breakdown.push(`Base rate: ${hourlyRate} AZN/hour × ${duration} minutes = ${baseAmount.toFixed(2)} AZN`);

      // 1. Same-day booking fee
      const hoursUntilAppointment = (appointmentTime.getTime() - new Date().getTime()) / (1000 * 60 * 60);
      if (hoursUntilAppointment < 24) {
        const sameDayFeePercentage = lawyer.bookingPolicy?.sameDayBookingFee || 0.25; // 25%
        modifiers.sameDayFee = Math.max(baseAmount * sameDayFeePercentage, this.MIN_SAME_DAY_FEE);
        breakdown.push(`Same-day booking fee: +${modifiers.sameDayFee.toFixed(2)} AZN`);
      }

      // 2. Premium time slots (6 PM - 9 PM)
      const appointmentHour = appointmentTime.getHours();
      if (appointmentHour >= 18 && appointmentHour <= 21) {
        modifiers.premiumTimeFee = baseAmount * 0.2; // 20% premium
        breakdown.push(`Premium evening time fee: +${modifiers.premiumTimeFee.toFixed(2)} AZN`);
      }

      // 3. Weekend consultations (Saturday & Sunday)
      const dayOfWeek = appointmentTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        modifiers.weekendFee = baseAmount * 0.15; // 15% weekend premium
        breakdown.push(`Weekend consultation fee: +${modifiers.weekendFee.toFixed(2)} AZN`);
      }

      // 4. Urgent consultation fee
      if (isUrgent) {
        modifiers.urgentFee = baseAmount * 0.5; // 50% urgent premium
        breakdown.push(`Urgent consultation fee: +${modifiers.urgentFee.toFixed(2)} AZN`);
      }

      // 5. Consultation type modifiers
      switch (consultationType) {
        case TempConsultationType.VIDEO:
          modifiers.consultationTypeFee = 0; // No additional fee
          break;
        case TempConsultationType.PHONE:
          modifiers.consultationTypeFee = -10; // 10 AZN discount
          breakdown.push(`Phone consultation discount: ${modifiers.consultationTypeFee.toFixed(2)} AZN`);
          break;
        case TempConsultationType.IN_PERSON:
          modifiers.consultationTypeFee = 25; // 25 AZN premium
          breakdown.push(`In-person consultation fee: +${modifiers.consultationTypeFee.toFixed(2)} AZN`);
          break;
        case TempConsultationType.EMERGENCY:
          modifiers.consultationTypeFee = baseAmount * 0.75; // 75% emergency premium
          breakdown.push(`Emergency consultation fee: +${modifiers.consultationTypeFee.toFixed(2)} AZN`);
          break;
      }

      // 6. Experience premium
      const experienceYears = lawyer.experience || 0;
      let experienceTier: keyof typeof this.EXPERIENCE_TIERS = 'junior';
      if (experienceYears >= 10) experienceTier = 'expert';
      else if (experienceYears >= 5) experienceTier = 'senior';
      else if (experienceYears >= 2) experienceTier = 'mid';

      modifiers.experiencePremium = baseAmount * this.EXPERIENCE_TIERS[experienceTier];
      if (modifiers.experiencePremium > 0) {
        breakdown.push(`Experience premium (${experienceYears}y, ${experienceTier}): +${modifiers.experiencePremium.toFixed(2)} AZN`);
      }

      // 7. Location-based fee (for in-person consultations)
      if (consultationType === TempConsultationType.IN_PERSON && clientLocation) {
        modifiers.locationFee = await this.calculateLocationFee('', clientLocation);
        if (modifiers.locationFee > 0) {
          breakdown.push(`Travel/location fee: +${modifiers.locationFee.toFixed(2)} AZN`);
        }
      }

      // Calculate subtotal
      const subtotal = baseAmount +
        modifiers.sameDayFee +
        modifiers.premiumTimeFee +
        modifiers.weekendFee +
        modifiers.urgentFee +
        modifiers.consultationTypeFee +
        modifiers.experiencePremium +
        modifiers.locationFee;

      // Platform fee calculation
      const platformFee = subtotal * this.PLATFORM_FEE_PERCENTAGE;
      breakdown.push(`Platform fee (${(this.PLATFORM_FEE_PERCENTAGE * 100).toFixed(0)}%): +${platformFee.toFixed(2)} AZN`);

      // Tax calculation (applied to platform fee only)
      const taxes = platformFee * this.TAX_RATE;
      breakdown.push(`VAT (${(this.TAX_RATE * 100).toFixed(0)}% on platform fee): +${taxes.toFixed(2)} AZN`);

      // Total amount
      const totalAmount = subtotal + platformFee + taxes;

      // Lawyer receives calculation
      const lawyerReceives = subtotal - (subtotal * this.PLATFORM_FEE_PERCENTAGE);
      const platformKeeps = platformFee + taxes;

      // Currency conversion if needed
      let finalCalculation = {
        baseAmount,
        modifiers,
        subtotal,
        platformFee,
        taxes,
        totalAmount,
        lawyerReceives,
        platformKeeps,
        currency: 'AZN',
        breakdown
      };

      if (currency !== 'AZN') {
        finalCalculation = await this.convertCurrency(finalCalculation, currency);
      }

      return finalCalculation;

    } catch (error) {
      console.error('Pricing calculation error:', error);
      throw new Error('Failed to calculate consultation cost');
    }
  }

  /**
   * Calculate location-based fee for in-person consultations
   */
  private async calculateLocationFee(lawyerLocation: string, clientLocation: string): Promise<number> {
    // This would normally integrate with a maps API to calculate distance
    // For now, we'll use a simple distance-based fee structure

    // Simplified logic: if locations are different, charge travel fee
    if (lawyerLocation.toLowerCase() !== clientLocation.toLowerCase()) {
      return 30; // 30 AZN travel fee
    }

    return 0;
  }

  /**
   * Convert pricing to different currency
   */
  private async convertCurrency(
    calculation: PricingCalculation,
    targetCurrency: string
  ): Promise<PricingCalculation> {
    try {
      const exchangeRate = await this.getExchangeRate('AZN', targetCurrency);

      return {
        ...calculation,
        baseAmount: calculation.baseAmount * exchangeRate,
        modifiers: {
          sameDayFee: calculation.modifiers.sameDayFee * exchangeRate,
          premiumTimeFee: calculation.modifiers.premiumTimeFee * exchangeRate,
          weekendFee: calculation.modifiers.weekendFee * exchangeRate,
          urgentFee: calculation.modifiers.urgentFee * exchangeRate,
          consultationTypeFee: calculation.modifiers.consultationTypeFee * exchangeRate,
          experiencePremium: calculation.modifiers.experiencePremium * exchangeRate,
          locationFee: calculation.modifiers.locationFee * exchangeRate
        },
        subtotal: calculation.subtotal * exchangeRate,
        platformFee: calculation.platformFee * exchangeRate,
        taxes: calculation.taxes * exchangeRate,
        totalAmount: calculation.totalAmount * exchangeRate,
        lawyerReceives: calculation.lawyerReceives * exchangeRate,
        platformKeeps: calculation.platformKeeps * exchangeRate,
        currency: targetCurrency,
        breakdown: calculation.breakdown.map(item =>
          item.replace(/[\d.]+\s*AZN/g, (match) => {
            const amount = parseFloat(match.replace(' AZN', ''));
            return `${(amount * exchangeRate).toFixed(2)} ${targetCurrency}`;
          })
        )
      };
    } catch (error) {
      console.error('Currency conversion error:', error);
      throw new Error('Failed to convert currency');
    }
  }

  /**
   * Get exchange rate between currencies
   */
  private async getExchangeRate(fromCurrency: string, toCurrency: string): Promise<number> {
    if (fromCurrency === toCurrency) return 1;

    try {
      const exchangeRate = await prisma.exchangeRate.findUnique({
        where: {
          fromCurrency_toCurrency: {
            fromCurrency: fromCurrency as any,
            toCurrency: toCurrency as any
          }
        }
      });

      return exchangeRate?.rate || 1;
    } catch (error) {
      console.error('Exchange rate lookup error:', error);
      // Return default rates if database lookup fails
      const defaultRates: ExchangeRates = {
        'AZN-USD': 0.59,
        'AZN-EUR': 0.54,
        'AZN-GBP': 0.47,
        'AZN-TRY': 16.2,
        'USD-AZN': 1.70,
        'EUR-AZN': 1.85,
        'GBP-AZN': 2.13,
        'TRY-AZN': 0.062
      };

      return defaultRates[`${fromCurrency}-${toCurrency}`] || 1;
    }
  }

  /**
   * Update exchange rates from external API
   */
  async updateExchangeRates(): Promise<void> {
    try {
      // This would normally fetch from a real exchange rate API
      const rates = [
        { from: 'AZN', to: 'USD', rate: 0.59 },
        { from: 'AZN', to: 'EUR', rate: 0.54 },
        { from: 'AZN', to: 'GBP', rate: 0.47 },
        { from: 'AZN', to: 'TRY', rate: 16.2 },
        { from: 'USD', to: 'AZN', rate: 1.70 },
        { from: 'EUR', to: 'AZN', rate: 1.85 },
        { from: 'GBP', to: 'AZN', rate: 2.13 },
        { from: 'TRY', to: 'AZN', rate: 0.062 }
      ];

      for (const rate of rates) {
        await prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency: {
              fromCurrency: rate.from as any,
              toCurrency: rate.to as any
            }
          },
          update: {
            rate: rate.rate,
            source: 'api_provider'
          },
          create: {
            fromCurrency: rate.from as any,
            toCurrency: rate.to as any,
            rate: rate.rate,
            source: 'api_provider'
          }
        });
      }

      console.log('Exchange rates updated successfully');
    } catch (error) {
      console.error('Failed to update exchange rates:', error);
    }
  }

  /**
   * Calculate discounts (for promotions, loyalty, etc.)
   */
  async calculateDiscounts(
    clientId: string,
    lawyerId: string,
    baseAmount: number
  ): Promise<{ discount: number; reason: string }> {
    try {
      let totalDiscount = 0;
      const reasons: string[] = [];

      // First-time client discount
      const previousAppointments = await prisma.appointment.count({
        where: {
          clientId,
          status: 'COMPLETED'
        }
      });

      if (previousAppointments === 0) {
        const firstTimeDiscount = baseAmount * 0.1; // 10% first-time discount
        totalDiscount += firstTimeDiscount;
        reasons.push('First-time client discount (10%)');
      }

      // Loyalty discount for returning clients
      if (previousAppointments >= 5) {
        const loyaltyDiscount = baseAmount * 0.05; // 5% loyalty discount
        totalDiscount += loyaltyDiscount;
        reasons.push('Loyalty discount (5%)');
      }

      // Volume discount for same lawyer
      const appointmentsWithLawyer = await prisma.appointment.count({
        where: {
          clientId,
          lawyerId,
          status: 'COMPLETED'
        }
      });

      if (appointmentsWithLawyer >= 3) {
        const volumeDiscount = baseAmount * 0.03; // 3% volume discount
        totalDiscount += volumeDiscount;
        reasons.push('Volume discount with same lawyer (3%)');
      }

      return {
        discount: totalDiscount,
        reason: reasons.join(', ')
      };
    } catch (error) {
      console.error('Discount calculation error:', error);
      return { discount: 0, reason: '' };
    }
  }

  /**
   * Get pricing summary for display
   */
  formatPricingSummary(calculation: PricingCalculation): string {
    let summary = `Consultation Cost Breakdown:\n`;
    summary += `================================\n`;

    calculation.breakdown.forEach(item => {
      summary += `${item}\n`;
    });

    summary += `--------------------------------\n`;
    summary += `Total Amount: ${calculation.totalAmount.toFixed(2)} ${calculation.currency}\n`;
    summary += `Lawyer Receives: ${calculation.lawyerReceives.toFixed(2)} ${calculation.currency}\n`;
    summary += `Platform Fee: ${calculation.platformKeeps.toFixed(2)} ${calculation.currency}\n`;

    return summary;
  }
}

export default new PricingEngineService();