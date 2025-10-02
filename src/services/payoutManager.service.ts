import prisma from '../config/database';
import { addDays, startOfMonth, endOfMonth, subDays, format, startOfWeek, endOfWeek } from 'date-fns';

enum PayoutStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

enum Currency {
  AZN = 'AZN',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  TRY = 'TRY'
}

interface PayoutCalculation {
  grossEarnings: number;
  platformFeeDeduction: number;
  refundDeductions: number;
  disputeDeductions: number;
  taxDeductions: number;
  netPayoutAmount: number;
  transactionCount: number;
  period: { from: Date; to: Date };
  breakdown: {
    completedConsultations: number;
    averageConsultationValue: number;
    totalConsultationTime: number; // in minutes
    platformFeePercentage: number;
    effectiveHourlyRate: number;
  };
}

interface PayoutRequest {
  lawyerId: string;
  requestedAmount?: number; // If not specified, pays out all available
  bankDetails?: {
    bankName: string;
    accountNumber: string;
    routingNumber?: string;
    iban?: string;
    swiftCode?: string;
  };
  notes?: string;
}

interface PayoutEligibility {
  isEligible: boolean;
  eligibilityReasons: string[];
  minimumThreshold: number;
  availableAmount: number;
  pendingAmount: number;
  holdPeriodDays: number;
  nextEligibleDate?: Date;
}

class PayoutManagerService {
  private readonly MINIMUM_PAYOUT_THRESHOLD = 50; // 50 AZN minimum
  private readonly HOLD_PERIOD_DAYS = 7; // Hold funds for 7 days after consultation
  private readonly PLATFORM_FEE_PERCENTAGE = 0.15; // 15%
  private readonly TAX_WITHHOLDING_PERCENTAGE = 0.18; // 18% Azerbaijan tax

  /**
   * Calculate lawyer's current earnings and payout eligibility
   */
  async calculateLawyerPayout(lawyerId: string, periodDays: number = 30): Promise<PayoutCalculation> {
    try {
      const endDate = new Date();
      const startDate = subDays(endDate, periodDays);

      // Get all completed appointments for the lawyer in the period
      const completedAppointments = await prisma.appointment.findMany({
        where: {
          lawyerId,
          status: 'COMPLETED',
          consultationEndedAt: {
            gte: startDate,
            lte: endDate
          }
        },
        include: {
          payment: {
            include: {
              refunds: true
            }
          }
        }
      });

      // Calculate gross earnings from completed consultations
      let grossEarnings = 0;
      let platformFeeDeduction = 0;
      let refundDeductions = 0;
      let totalConsultationTime = 0;
      const transactionCount = completedAppointments.length;

      for (const appointment of completedAppointments) {
        if (appointment.payment && appointment.payment.status === 'CAPTURED') {
          const appointmentGross = appointment.payment.totalAmount;
          const platformFee = appointment.payment.platformFee;
          const refundAmount = appointment.payment.refunds.reduce((sum, refund) => sum + refund.amount, 0);

          grossEarnings += appointmentGross;
          platformFeeDeduction += platformFee;
          refundDeductions += refundAmount;
          totalConsultationTime += appointment.actualDuration || appointment.consultationDuration;
        }
      }

      // Get dispute deductions (funds held due to disputes)
      const disputeDeductions = await this.calculateDisputeDeductions(lawyerId, startDate, endDate);

      // Calculate tax deductions
      const taxableAmount = grossEarnings - platformFeeDeduction - refundDeductions;
      const taxDeductions = taxableAmount * this.TAX_WITHHOLDING_PERCENTAGE;

      // Calculate net payout amount
      const netPayoutAmount = grossEarnings - platformFeeDeduction - refundDeductions - disputeDeductions - taxDeductions;

      // Calculate breakdown metrics
      const averageConsultationValue = transactionCount > 0 ? grossEarnings / transactionCount : 0;
      const effectiveHourlyRate = totalConsultationTime > 0 ? (netPayoutAmount / totalConsultationTime) * 60 : 0;

      return {
        grossEarnings: Math.round(grossEarnings * 100) / 100,
        platformFeeDeduction: Math.round(platformFeeDeduction * 100) / 100,
        refundDeductions: Math.round(refundDeductions * 100) / 100,
        disputeDeductions: Math.round(disputeDeductions * 100) / 100,
        taxDeductions: Math.round(taxDeductions * 100) / 100,
        netPayoutAmount: Math.round(netPayoutAmount * 100) / 100,
        transactionCount,
        period: { from: startDate, to: endDate },
        breakdown: {
          completedConsultations: transactionCount,
          averageConsultationValue: Math.round(averageConsultationValue * 100) / 100,
          totalConsultationTime,
          platformFeePercentage: this.PLATFORM_FEE_PERCENTAGE * 100,
          effectiveHourlyRate: Math.round(effectiveHourlyRate * 100) / 100
        }
      };

    } catch (error) {
      console.error('Payout calculation error:', error);
      throw error;
    }
  }

  /**
   * Check payout eligibility for a lawyer
   */
  async checkPayoutEligibility(lawyerId: string): Promise<PayoutEligibility> {
    try {
      const lawyer = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { user: true }
      });

      if (!lawyer) {
        throw new Error('Lawyer not found');
      }

      const eligibilityReasons: string[] = [];
      let isEligible = true;

      // Check if lawyer is verified
      if (!lawyer.isVerified) {
        isEligible = false;
        eligibilityReasons.push('Lawyer profile not verified');
      }

      // Calculate available earnings (after hold period)
      const holdPeriodCutoff = subDays(new Date(), this.HOLD_PERIOD_DAYS);
      const availableEarnings = await this.calculateAvailableEarnings(lawyerId, holdPeriodCutoff);

      // Check minimum threshold
      if (availableEarnings < this.MINIMUM_PAYOUT_THRESHOLD) {
        isEligible = false;
        eligibilityReasons.push(`Minimum payout threshold of ${this.MINIMUM_PAYOUT_THRESHOLD} AZN not met`);
      }

      // Check for pending payouts
      const pendingPayout = await prisma.payout.findFirst({
        where: {
          lawyerId,
          status: { in: ['PENDING', 'PROCESSING'] }
        }
      });

      let pendingAmount = 0;
      if (pendingPayout) {
        pendingAmount = pendingPayout.netAmount;
        eligibilityReasons.push(`Payout of ${pendingAmount} AZN already pending processing`);
      }

      // Check for unresolved disputes
      const unresolvedDisputes = await prisma.dispute.count({
        where: {
          appointment: {
            lawyerId
          },
          status: { in: ['OPEN', 'INVESTIGATING'] }
        }
      });

      if (unresolvedDisputes > 0) {
        isEligible = false;
        eligibilityReasons.push(`${unresolvedDisputes} unresolved dispute(s) pending`);
      }

      // Calculate next eligible date
      let nextEligibleDate: Date | undefined;
      if (!isEligible && availableEarnings < this.MINIMUM_PAYOUT_THRESHOLD) {
        // Estimate when minimum threshold might be reached
        const recentEarningsRate = await this.calculateDailyEarningsRate(lawyerId);
        if (recentEarningsRate > 0) {
          const daysToThreshold = Math.ceil((this.MINIMUM_PAYOUT_THRESHOLD - availableEarnings) / recentEarningsRate);
          nextEligibleDate = addDays(new Date(), daysToThreshold);
        }
      }

      return {
        isEligible: isEligible && !pendingPayout,
        eligibilityReasons,
        minimumThreshold: this.MINIMUM_PAYOUT_THRESHOLD,
        availableAmount: Math.round(availableEarnings * 100) / 100,
        pendingAmount: Math.round(pendingAmount * 100) / 100,
        holdPeriodDays: this.HOLD_PERIOD_DAYS,
        nextEligibleDate
      };

    } catch (error) {
      console.error('Payout eligibility check error:', error);
      throw error;
    }
  }

  /**
   * Request payout for a lawyer
   */
  async requestPayout(params: PayoutRequest): Promise<{
    success: boolean;
    payoutId?: string;
    error?: string;
    estimatedProcessingTime?: string;
  }> {
    try {
      const { lawyerId, requestedAmount, bankDetails, notes } = params;

      // Check eligibility
      const eligibility = await this.checkPayoutEligibility(lawyerId);
      if (!eligibility.isEligible) {
        return {
          success: false,
          error: `Payout not eligible: ${eligibility.eligibilityReasons.join(', ')}`
        };
      }

      // Determine payout amount
      const payoutAmount = requestedAmount || eligibility.availableAmount;
      if (payoutAmount > eligibility.availableAmount) {
        return {
          success: false,
          error: `Requested amount (${payoutAmount}) exceeds available amount (${eligibility.availableAmount})`
        };
      }

      // Get earnings breakdown for the payout period
      const calculation = await this.calculateLawyerPayout(lawyerId, 30);

      // Generate payout reference
      const payoutReference = `PAYOUT-${lawyerId.slice(-6)}-${Date.now()}`;

      // Create payout record
      const payout = await prisma.$transaction(async (tx) => {
        // Create payout
        const newPayout = await tx.payout.create({
          data: {
            lawyerId,
            payoutReference,
            grossAmount: calculation.grossEarnings,
            platformFee: calculation.platformFeeDeduction,
            taxes: calculation.taxDeductions,
            netAmount: payoutAmount,
            currency: Currency.AZN,
            periodStart: calculation.period.from,
            periodEnd: calculation.period.to,
            appointmentCount: calculation.transactionCount,
            status: PayoutStatus.PENDING,
            bankName: bankDetails?.bankName,
            accountNumber: bankDetails?.accountNumber,
            routingNumber: bankDetails?.routingNumber,
            iban: bankDetails?.iban,
            swiftCode: bankDetails?.swiftCode,
            provider: 'STRIPE' // Default provider
          }
        });

        // Create payout items for each completed appointment
        const completedAppointments = await tx.appointment.findMany({
          where: {
            lawyerId,
            status: 'COMPLETED',
            consultationEndedAt: {
              gte: calculation.period.from,
              lte: calculation.period.to
            }
          },
          include: {
            client: true,
            payment: true
          }
        });

        for (const appointment of completedAppointments) {
          if (appointment.payment && appointment.payment.status === 'CAPTURED') {
            await tx.payoutItem.create({
              data: {
                payoutId: newPayout.id,
                appointmentId: appointment.id,
                consultationDate: appointment.startTime,
                clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
                consultationType: appointment.consultationType as any,
                duration: appointment.actualDuration || appointment.consultationDuration,
                baseAmount: appointment.payment.baseAmount,
                platformFee: appointment.payment.platformFee,
                lawyerEarning: appointment.payment.totalAmount - appointment.payment.platformFee - appointment.payment.taxes
              }
            });
          }
        }

        return newPayout;
      });

      return {
        success: true,
        payoutId: payout.id,
        estimatedProcessingTime: '2-3 business days'
      };

    } catch (error) {
      console.error('Payout request error:', error);
      return {
        success: false,
        error: 'Failed to process payout request'
      };
    }
  }

  /**
   * Get payout status and details
   */
  async getPayoutStatus(payoutId: string): Promise<any> {
    try {
      const payout = await prisma.payout.findUnique({
        where: { id: payoutId },
        include: {
          lawyer: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true
                }
              }
            }
          },
          payoutItems: {
            include: {
              appointment: {
                select: {
                  id: true,
                  startTime: true,
                  consultationType: true
                }
              }
            }
          }
        }
      });

      if (!payout) {
        return null;
      }

      return {
        id: payout.id,
        payoutReference: payout.payoutReference,
        status: payout.status,
        netAmount: payout.netAmount,
        currency: payout.currency,
        requestedAt: payout.requestedAt,
        processedAt: payout.processedAt,
        completedAt: payout.completedAt,
        failedAt: payout.failedAt,
        failureReason: payout.failureReason,
        bankDetails: {
          bankName: payout.bankName,
          accountNumber: payout.accountNumber ? `****${payout.accountNumber.slice(-4)}` : null,
          iban: payout.iban ? `****${payout.iban.slice(-4)}` : null
        },
        breakdown: {
          grossAmount: payout.grossAmount,
          platformFee: payout.platformFee,
          taxes: payout.taxes,
          netAmount: payout.netAmount,
          appointmentCount: payout.appointmentCount,
          period: {
            start: payout.periodStart,
            end: payout.periodEnd
          }
        },
        items: payout.payoutItems.map(item => ({
          consultationDate: item.consultationDate,
          clientName: item.clientName,
          consultationType: item.consultationType,
          duration: item.duration,
          earning: item.lawyerEarning
        }))
      };

    } catch (error) {
      console.error('Get payout status error:', error);
      return null;
    }
  }

  /**
   * Get lawyer's earnings dashboard data
   */
  async getLawyerEarningsDashboard(lawyerId: string): Promise<{
    currentBalance: number;
    pendingPayouts: number;
    totalEarnings: number;
    thisMonth: PayoutCalculation;
    lastMonth: PayoutCalculation;
    recentPayouts: any[];
    earningsChart: Array<{ date: string; earnings: number; consultations: number }>;
  }> {
    try {
      // Get current available balance
      const eligibility = await this.checkPayoutEligibility(lawyerId);

      // Calculate this month's earnings
      const thisMonthStart = startOfMonth(new Date());
      const thisMonthEnd = endOfMonth(new Date());
      const thisMonth = await this.calculateLawyerPayout(lawyerId, 30);

      // Calculate last month's earnings
      const lastMonthStart = startOfMonth(subDays(new Date(), 30));
      const lastMonthEnd = endOfMonth(subDays(new Date(), 30));
      const lastMonthDays = Math.ceil((lastMonthEnd.getTime() - lastMonthStart.getTime()) / (1000 * 60 * 60 * 24));
      const lastMonth = await this.calculateLawyerPayout(lawyerId, lastMonthDays);

      // Get recent payouts
      const recentPayouts = await prisma.payout.findMany({
        where: { lawyerId },
        orderBy: { requestedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          payoutReference: true,
          netAmount: true,
          status: true,
          requestedAt: true,
          completedAt: true
        }
      });

      // Calculate total lifetime earnings
      const totalPayouts = await prisma.payout.aggregate({
        where: {
          lawyerId,
          status: 'COMPLETED'
        },
        _sum: {
          netAmount: true
        }
      });

      // Generate earnings chart for last 30 days
      const earningsChart = await this.generateEarningsChart(lawyerId, 30);

      return {
        currentBalance: eligibility.availableAmount,
        pendingPayouts: eligibility.pendingAmount,
        totalEarnings: totalPayouts._sum.netAmount || 0,
        thisMonth,
        lastMonth,
        recentPayouts,
        earningsChart
      };

    } catch (error) {
      console.error('Earnings dashboard error:', error);
      throw error;
    }
  }

  /**
   * Process pending payouts (admin function)
   */
  async processPendingPayouts(): Promise<{
    processed: number;
    failed: number;
    errors: Array<{ payoutId: string; error: string }>;
  }> {
    try {
      const pendingPayouts = await prisma.payout.findMany({
        where: { status: PayoutStatus.PENDING },
        include: {
          lawyer: {
            include: {
              user: true
            }
          }
        }
      });

      const results = {
        processed: 0,
        failed: 0,
        errors: [] as Array<{ payoutId: string; error: string }>
      };

      for (const payout of pendingPayouts) {
        try {
          // Update to processing status
          await prisma.payout.update({
            where: { id: payout.id },
            data: {
              status: PayoutStatus.PROCESSING,
              processedAt: new Date()
            }
          });

          // Here you would integrate with payment provider to initiate bank transfer
          // For now, we'll simulate successful processing
          await new Promise(resolve => setTimeout(resolve, 100)); // Simulate processing time

          // Mark as completed
          await prisma.payout.update({
            where: { id: payout.id },
            data: {
              status: PayoutStatus.COMPLETED,
              completedAt: new Date()
            }
          });

          results.processed++;

        } catch (error) {
          // Mark as failed
          await prisma.payout.update({
            where: { id: payout.id },
            data: {
              status: PayoutStatus.FAILED,
              failedAt: new Date(),
              failureReason: error instanceof Error ? error.message : 'Processing failed'
            }
          });

          results.failed++;
          results.errors.push({
            payoutId: payout.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      return results;

    } catch (error) {
      console.error('Process pending payouts error:', error);
      throw error;
    }
  }

  /**
   * Calculate dispute deductions for a period
   */
  private async calculateDisputeDeductions(lawyerId: string, startDate: Date, endDate: Date): Promise<number> {
    try {
      const disputes = await prisma.dispute.findMany({
        where: {
          appointment: {
            lawyerId,
            startTime: {
              gte: startDate,
              lte: endDate
            }
          },
          status: { in: ['OPEN', 'INVESTIGATING'] }
        }
      });

      return disputes.reduce((sum, dispute) => sum + dispute.amount, 0);

    } catch (error) {
      console.error('Dispute deductions calculation error:', error);
      return 0;
    }
  }

  /**
   * Calculate available earnings (after hold period)
   */
  private async calculateAvailableEarnings(lawyerId: string, cutoffDate: Date): Promise<number> {
    try {
      const availableAppointments = await prisma.appointment.findMany({
        where: {
          lawyerId,
          status: 'COMPLETED',
          consultationEndedAt: { lte: cutoffDate }
        },
        include: {
          payment: {
            include: {
              refunds: true
            }
          }
        }
      });

      let availableEarnings = 0;

      for (const appointment of availableAppointments) {
        if (appointment.payment && appointment.payment.status === 'CAPTURED') {
          const gross = appointment.payment.totalAmount;
          const platformFee = appointment.payment.platformFee;
          const refunds = appointment.payment.refunds.reduce((sum, r) => sum + r.amount, 0);
          const taxes = appointment.payment.taxes;

          availableEarnings += gross - platformFee - refunds - taxes;
        }
      }

      // Subtract already paid out amounts
      const paidOut = await prisma.payout.aggregate({
        where: {
          lawyerId,
          status: { in: ['COMPLETED', 'PROCESSING'] }
        },
        _sum: {
          netAmount: true
        }
      });

      return Math.max(0, availableEarnings - (paidOut._sum.netAmount || 0));

    } catch (error) {
      console.error('Available earnings calculation error:', error);
      return 0;
    }
  }

  /**
   * Calculate daily earnings rate for prediction
   */
  private async calculateDailyEarningsRate(lawyerId: string): Promise<number> {
    try {
      const last30Days = subDays(new Date(), 30);
      const calculation = await this.calculateLawyerPayout(lawyerId, 30);

      return calculation.netPayoutAmount / 30; // Daily average

    } catch (error) {
      console.error('Daily earnings rate calculation error:', error);
      return 0;
    }
  }

  /**
   * Generate earnings chart data
   */
  private async generateEarningsChart(lawyerId: string, days: number): Promise<Array<{
    date: string;
    earnings: number;
    consultations: number;
  }>> {
    try {
      const endDate = new Date();
      const startDate = subDays(endDate, days);

      const dailyEarnings = await prisma.appointment.groupBy({
        by: ['consultationEndedAt'],
        where: {
          lawyerId,
          status: 'COMPLETED',
          consultationEndedAt: {
            gte: startDate,
            lte: endDate
          }
        },
        _count: true,
        _sum: {
          totalAmount: true
        }
      });

      // Fill in missing days with zero values
      const chartData: Array<{ date: string; earnings: number; consultations: number }> = [];

      for (let i = 0; i < days; i++) {
        const date = subDays(endDate, i);
        const dateStr = format(date, 'yyyy-MM-dd');

        const dayData = dailyEarnings.find(d =>
          d.consultationEndedAt && format(d.consultationEndedAt, 'yyyy-MM-dd') === dateStr
        );

        chartData.unshift({
          date: dateStr,
          earnings: dayData?._sum.totalAmount || 0,
          consultations: dayData?._count || 0
        });
      }

      return chartData;

    } catch (error) {
      console.error('Earnings chart generation error:', error);
      return [];
    }
  }
}

export default new PayoutManagerService();