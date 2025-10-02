import prisma from '../config/database';
import { PayoutStatus, Currency } from '@prisma/client';

// Temporary enums until Prisma client is regenerated
enum TempPayoutStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PAID = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

interface PayoutCalculation {
  grossAmount: number;
  platformFee: number;
  taxes: number;
  deductions: number;
  netAmount: number;
  currency: string;
  breakdown: string[];
}

interface PayoutRequest {
  lawyerId: string;
  requestedAmount?: number;
  requestedBy: string;
  reason?: string;
}

interface PayoutBatchParams {
  lawyerIds?: string[];
  periodStart: Date;
  periodEnd: Date;
  minAmount?: number;
  currency?: string;
}

interface BankAccountDetails {
  bankName: string;
  accountNumber: string;
  routingNumber?: string;
  iban?: string;
  swiftCode?: string;
  accountHolderName: string;
  accountType: 'checking' | 'savings' | 'business';
}

interface PayoutResult {
  success: boolean;
  payoutId?: string;
  payoutReference?: string;
  netAmount?: number;
  currency?: string;
  error?: string;
  estimatedSettlement?: Date;
}

class PayoutProcessorService {
  private readonly PLATFORM_FEE_PERCENTAGE = 0.15; // 15%
  private readonly TAX_RATE = 0.18; // 18% VAT for Azerbaijan
  private readonly MIN_PAYOUT_AMOUNT = 50; // Minimum 50 AZN
  private readonly PAYOUT_PROCESSING_FEE = 2.5; // 2.5 AZN per payout
  private readonly MAX_MONTHLY_TAX_FREE = 1000; // First 1000 AZN is tax-free per month

  /**
   * Calculate payout amounts with all deductions
   */
  async calculatePayout(
    lawyerId: string,
    periodStart: Date,
    periodEnd: Date,
    currency: string = 'AZN'
  ): Promise<PayoutCalculation> {
    try {
      // Get completed appointments for the period
      const appointments = await prisma.appointment.findMany({
        where: {
          lawyerId,
          status: 'COMPLETED',
          consultationEndedAt: {
            gte: periodStart,
            lte: periodEnd
          },
          payment: {
            status: 'CAPTURED'
          }
        },
        include: {
          payment: true,
          client: true
        }
      });

      let grossAmount = 0;
      const breakdown: string[] = [];

      // Calculate gross earnings
      for (const appointment of appointments) {
        if (appointment.payment) {
          const lawyerEarning = appointment.payment.totalAmount - appointment.payment.platformFee - appointment.payment.taxes;
          grossAmount += lawyerEarning;
          breakdown.push(`${appointment.client.firstName} ${appointment.client.lastName} - ${appointment.consultationType}: ${lawyerEarning.toFixed(2)} AZN`);
        }
      }

      if (grossAmount === 0) {
        return {
          grossAmount: 0,
          platformFee: 0,
          taxes: 0,
          deductions: 0,
          netAmount: 0,
          currency,
          breakdown: ['No completed consultations in the specified period']
        };
      }

      breakdown.push(`Total Gross Earnings: ${grossAmount.toFixed(2)} AZN`);

      // Platform fee is already deducted at payment time, so this is 0
      const platformFee = 0;

      // Calculate taxes on gross amount
      const taxableAmount = Math.max(0, grossAmount - this.MAX_MONTHLY_TAX_FREE);
      const taxes = taxableAmount * this.TAX_RATE;
      if (taxes > 0) {
        breakdown.push(`Tax on ${taxableAmount.toFixed(2)} AZN (${(this.TAX_RATE * 100).toFixed(0)}%): -${taxes.toFixed(2)} AZN`);
      }
      if (grossAmount <= this.MAX_MONTHLY_TAX_FREE) {
        breakdown.push(`Tax-free amount (first ${this.MAX_MONTHLY_TAX_FREE} AZN): 0.00 AZN`);
      }

      // Processing fee
      const processingFee = this.PAYOUT_PROCESSING_FEE;
      breakdown.push(`Processing Fee: -${processingFee.toFixed(2)} AZN`);

      // Calculate other deductions
      const otherDeductions = await this.calculateOtherDeductions(lawyerId, grossAmount);
      let totalOtherDeductions = 0;
      for (const [reason, amount] of Object.entries(otherDeductions)) {
        totalOtherDeductions += amount;
        if (amount > 0) {
          breakdown.push(`${reason}: -${amount.toFixed(2)} AZN`);
        }
      }

      const totalDeductions = taxes + processingFee + totalOtherDeductions;
      const netAmount = grossAmount - totalDeductions;

      breakdown.push(`Net Payout Amount: ${netAmount.toFixed(2)} AZN`);

      return {
        grossAmount,
        platformFee,
        taxes,
        deductions: totalDeductions,
        netAmount,
        currency,
        breakdown
      };

    } catch (error) {
      console.error('Payout calculation error:', error);
      throw new Error('Failed to calculate payout');
    }
  }

  /**
   * Create payout request
   */
  async createPayout(params: PayoutRequest): Promise<PayoutResult> {
    try {
      const { lawyerId, requestedAmount, requestedBy, reason } = params;

      // Get lawyer profile
      const lawyerProfile = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: {
          user: true
        }
      });

      if (!lawyerProfile) {
        return { success: false, error: 'Lawyer not found' };
      }

      // Calculate current period earnings (month-to-date)
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      const calculation = await this.calculatePayout(lawyerId, periodStart, periodEnd);

      // Determine payout amount
      let payoutAmount = requestedAmount || calculation.netAmount;
      if (requestedAmount && requestedAmount > calculation.netAmount) {
        return { success: false, error: 'Requested amount exceeds available earnings' };
      }

      // Check minimum payout amount
      if (payoutAmount < this.MIN_PAYOUT_AMOUNT) {
        return { success: false, error: `Minimum payout amount is ${this.MIN_PAYOUT_AMOUNT} AZN` };
      }

      // Check if there's already a pending payout for this period
      const existingPayout = await prisma.payout.findFirst({
        where: {
          lawyerId,
          status: { in: ['PENDING', 'PROCESSING'] },
          periodStart,
          periodEnd
        }
      });

      if (existingPayout) {
        return { success: false, error: 'A payout is already pending for this period' };
      }

      // Generate payout reference
      const payoutReference = this.generatePayoutReference(lawyerId);

      // Create payout record
      const payout = await prisma.payout.create({
        data: {
          lawyerId,
          payoutReference,
          grossAmount: calculation.grossAmount,
          platformFee: calculation.platformFee,
          taxes: calculation.taxes,

          netAmount: payoutAmount,
          currency: calculation.currency as any,
          status: TempPayoutStatus.PENDING,
          periodStart,
          periodEnd


        }
      });

      // Create payout items for each appointment
      await this.createPayoutItems(payout.id, lawyerId, periodStart, periodEnd);

      // Log payout creation
      await this.logPayoutAction(
        payout.id,
        'created',
        requestedBy,
        'Payout request created',
        { amount: payoutAmount, currency: calculation.currency }
      );

      return {
        success: true,
        payoutId: payout.id,
        payoutReference: payout.payoutReference,
        netAmount: payoutAmount,
        currency: calculation.currency,
        estimatedSettlement: new Date(payout.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)
      };

    } catch (error) {
      console.error('Create payout error:', error);
      return { success: false, error: 'Failed to create payout request' };
    }
  }

  /**
   * Process payout batch
   */
  async processBatch(params: PayoutBatchParams): Promise<{ processed: number; failed: number; errors: string[] }> {
    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      const { lawyerIds, periodStart, periodEnd, minAmount = this.MIN_PAYOUT_AMOUNT, currency = 'AZN' } = params;

      // Get lawyers eligible for payout
      let eligibleLawyers;
      if (lawyerIds?.length) {
        eligibleLawyers = await prisma.lawyerProfile.findMany({
          where: { id: { in: lawyerIds } },
          include: { user: true }
        });
      } else {
        // Find all lawyers with completed appointments in the period
        eligibleLawyers = await prisma.lawyerProfile.findMany({
          where: {
            appointments: {
              some: {
                status: 'COMPLETED',
                consultationEndedAt: { gte: periodStart, lte: periodEnd },
                payment: { status: 'CAPTURED' }
              }
            }
          },
          include: { user: true }
        });
      }

      for (const lawyer of eligibleLawyers) {
        try {
          // Check if payout already exists for this period
          const existingPayout = await prisma.payout.findFirst({
            where: {
              lawyerId: lawyer.id,
              periodStart,
              periodEnd,
              status: { not: 'CANCELLED' }
            }
          });

          if (existingPayout) {
            continue; // Skip if already processed
          }

          // Calculate earnings
          const calculation = await this.calculatePayout(lawyer.id, periodStart, periodEnd, currency);

          if (calculation.netAmount >= minAmount) {
            const result = await this.createPayout({
              lawyerId: lawyer.id,
              requestedBy: 'system',
              reason: 'Automated batch payout'
            });

            if (result.success) {
              processed++;
            } else {
              failed++;
              errors.push(`${lawyer.user.firstName} ${lawyer.user.lastName}: ${result.error}`);
            }
          }
        } catch (error) {
          failed++;
          errors.push(`${lawyer.user.firstName} ${lawyer.user.lastName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      console.log(`Batch payout processing complete: ${processed} processed, ${failed} failed`);
      return { processed, failed, errors };

    } catch (error) {
      console.error('Batch payout processing error:', error);
      return { processed, failed: failed + 1, errors: [...errors, 'Batch processing system error'] };
    }
  }

  /**
   * Approve payout for processing
   */
  async approvePayout(payoutId: string, approvedBy: string): Promise<PayoutResult> {
    try {
      const payout = await prisma.payout.findUnique({
        where: { id: payoutId },
        include: {
          lawyer: { include: { user: true } }
        }
      });

      if (!payout) {
        return { success: false, error: 'Payout not found' };
      }

      if (payout.status !== TempPayoutStatus.PENDING) {
        return { success: false, error: `Cannot approve payout with status: ${payout.status}` };
      }

      // Update payout status
      const updatedPayout = await prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: TempPayoutStatus.PROCESSING,
          processedAt: new Date()
        }
      });

      // Log approval
      await this.logPayoutAction(
        payoutId,
        'approved',
        approvedBy,
        'Payout approved for processing',
        { amount: payout.netAmount, currency: payout.currency }
      );

      // TODO: Integrate with bank/payment processor for actual transfer
      // For now, we'll simulate processing
      await this.simulatePayoutProcessing(payoutId);

      return {
        success: true,
        payoutId: updatedPayout.id,
        payoutReference: updatedPayout.payoutReference,
        netAmount: updatedPayout.netAmount,
        currency: updatedPayout.currency,
        estimatedSettlement: new Date(updatedPayout.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)
      };

    } catch (error) {
      console.error('Approve payout error:', error);
      return { success: false, error: 'Failed to approve payout' };
    }
  }

  /**
   * Mark payout as paid
   */
  async markPayoutPaid(
    payoutId: string,
    bankTransactionId: string,
    actualSettlementDate: Date,
    paidBy: string
  ): Promise<PayoutResult> {
    try {
      const payout = await prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: TempPayoutStatus.PAID,

          updatedAt: new Date()
        }
      });

      // Log payment completion
      await this.logPayoutAction(
        payoutId,
        'paid',
        paidBy,
        'Payout successfully transferred to bank account',
        {
          amount: payout.netAmount,
          currency: payout.currency,
          bankTransactionId,
          settlementDate: actualSettlementDate
        }
      );

      return {
        success: true,
        payoutId: payout.id,
        payoutReference: payout.payoutReference,
        netAmount: payout.netAmount,
        currency: payout.currency
      };

    } catch (error) {
      console.error('Mark payout paid error:', error);
      return { success: false, error: 'Failed to mark payout as paid' };
    }
  }

  /**
   * Cancel payout
   */
  async cancelPayout(payoutId: string, reason: string, cancelledBy: string): Promise<PayoutResult> {
    try {
      const payout = await prisma.payout.findUnique({
        where: { id: payoutId }
      });

      if (!payout) {
        return { success: false, error: 'Payout not found' };
      }

      if (payout.status === TempPayoutStatus.PAID) {
        return { success: false, error: 'Cannot cancel a paid payout' };
      }

      // Update payout status
      await prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: TempPayoutStatus.CANCELLED,



        }
      });

      // Log cancellation
      await this.logPayoutAction(
        payoutId,
        'cancelled',
        cancelledBy,
        `Payout cancelled: ${reason}`,
        { originalAmount: payout.netAmount, currency: payout.currency }
      );

      return { success: true };

    } catch (error) {
      console.error('Cancel payout error:', error);
      return { success: false, error: 'Failed to cancel payout' };
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
            include: { user: true }
          },
          payoutItems: {
            include: {
              appointment: {
                include: {
                  client: {
                    select: { firstName: true, lastName: true }
                  }
                }
              }
            }
          }
        }
      });

      return payout;
    } catch (error) {
      console.error('Get payout status error:', error);
      return null;
    }
  }

  /**
   * Get lawyer payout history
   */
  async getPayoutHistory(
    lawyerId: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<any[]> {
    try {
      const payouts = await prisma.payout.findMany({
        where: { lawyerId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          lawyer: {
            select: { id: true, userId: true, licenseNumber: true }
          }
        }
      });

      return payouts;
    } catch (error) {
      console.error('Get payout history error:', error);
      return [];
    }
  }

  /**
   * Calculate other deductions (chargebacks, penalties, etc.)
   */
  private async calculateOtherDeductions(lawyerId: string, grossAmount: number): Promise<Record<string, number>> {
    const deductions: Record<string, number> = {};

    try {
      // Check for pending chargebacks
      const chargebacks = await prisma.refund.aggregate({
        where: {
          payment: {
            appointment: { lawyerId }
          },
          refundType: 'dispute',
          status: 'PENDING'
        },
        _sum: { amount: true }
      });

      if (chargebacks._sum.amount) {
        deductions['Pending Chargebacks'] = chargebacks._sum.amount;
      }

      // Check for platform penalties
      // This would be based on lawyer performance metrics, policy violations, etc.
      const penalties = await this.calculatePenalties(lawyerId);
      if (penalties > 0) {
        deductions['Platform Penalties'] = penalties;
      }

      // Check for withholding (for new lawyers)
      const lawyerProfile = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { user: true }
      });

      if (lawyerProfile) {
        const accountAge = Date.now() - lawyerProfile.user.createdAt.getTime();
        const daysOld = accountAge / (1000 * 60 * 60 * 24);

        // Withhold 10% for first 30 days
        if (daysOld < 30) {
          deductions['New Lawyer Withholding (10%)'] = grossAmount * 0.1;
        }
      }

    } catch (error) {
      console.error('Calculate deductions error:', error);
    }

    return deductions;
  }

  /**
   * Calculate platform penalties
   */
  private async calculatePenalties(lawyerId: string): Promise<number> {
    // This would be based on various factors:
    // - Late consultations
    // - Poor ratings
    // - Policy violations
    // - Cancelled appointments

    // For now, return 0 (no penalties)
    return 0;
  }

  /**
   * Create payout items for tracking
   */
  private async createPayoutItems(
    payoutId: string,
    lawyerId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<void> {
    try {
      const appointments = await prisma.appointment.findMany({
        where: {
          lawyerId,
          status: 'COMPLETED',
          consultationEndedAt: { gte: periodStart, lte: periodEnd },
          payment: { status: 'CAPTURED' }
        },
        include: {
          payment: true,
          client: true
        }
      });

      for (const appointment of appointments) {
        if (appointment.payment) {
          const lawyerEarning = appointment.payment.totalAmount - appointment.payment.platformFee - appointment.payment.taxes;

          await prisma.payoutItem.create({
            data: {
              payoutId,
              appointmentId: appointment.id,
              consultationDate: appointment.startTime,
              clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
              consultationType: appointment.consultationType as any,
              duration: appointment.consultationDuration,
              baseAmount: appointment.payment.baseAmount,
              platformFee: appointment.payment.platformFee,
              lawyerEarning
            }
          });
        }
      }
    } catch (error) {
      console.error('Create payout items error:', error);
    }
  }

  /**
   * Generate unique payout reference
   */
  private generatePayoutReference(lawyerId: string): string {
    const timestamp = Date.now().toString().slice(-8);
    const lawyerSuffix = lawyerId.slice(-4).toUpperCase();
    return `PAYOUT-${lawyerSuffix}-${timestamp}`;
  }

  /**
   * Calculate settlement date
   */
  private calculateSettlementDate(): Date {
    const now = new Date();
    // Add 2-3 business days for settlement
    const settlementDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    return settlementDate;
  }

  /**
   * Simulate payout processing (replace with real bank integration)
   */
  private async simulatePayoutProcessing(payoutId: string): Promise<void> {
    // Simulate async processing
    setTimeout(async () => {
      try {
        const bankTransactionId = `TXN-${Date.now()}`;
        await this.markPayoutPaid(payoutId, bankTransactionId, new Date(), 'system');
      } catch (error) {
        console.error('Simulated payout processing error:', error);
        // Mark as failed
        await prisma.payout.update({
          where: { id: payoutId },
          data: {
            status: TempPayoutStatus.FAILED,
            failureReason: 'Bank processing failed'
          }
        });
      }
    }, 5000); // Simulate 5 second processing time
  }

  /**
   * Log payout actions for audit trail
   */
  private async logPayoutAction(
    payoutId: string,
    action: string,
    performedBy: string,
    description: string,
    metadata: any
  ): Promise<void> {
    try {
      console.log(`Payout Action Log: ${action} on ${payoutId} by ${performedBy} - ${description}`, metadata);
      // In production, store in dedicated audit log table
    } catch (error) {
      console.error('Failed to log payout action:', error);
    }
  }

  /**
   * Generate payout report
   */
  async generatePayoutReport(startDate: Date, endDate: Date): Promise<any> {
    try {
      const payouts = await prisma.payout.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate }
        },
        include: {
          lawyer: { include: { user: true } }
        }
      });

      const totalPayouts = payouts.length;
      const totalAmount = payouts.reduce((sum, payout) => sum + payout.netAmount, 0);
      const paidPayouts = payouts.filter(p => p.status === 'COMPLETED').length;
      const pendingPayouts = payouts.filter(p => p.status === 'PENDING').length;
      const failedPayouts = payouts.filter(p => p.status === 'FAILED').length;

      return {
        period: { startDate, endDate },
        statistics: {
          totalPayouts,
          totalAmount: totalAmount.toFixed(2),
          paidPayouts,
          pendingPayouts,
          failedPayouts,
          successRate: totalPayouts > 0 ? ((paidPayouts / totalPayouts) * 100).toFixed(2) + '%' : '0%'
        },
        payouts: payouts.map(payout => ({
          id: payout.id,
          reference: payout.payoutReference,
          lawyer: `${payout.lawyer.user.firstName} ${payout.lawyer.user.lastName}`,
          amount: payout.netAmount,
          currency: payout.currency,
          status: payout.status,
          createdAt: payout.createdAt
        }))
      };
    } catch (error) {
      console.error('Generate payout report error:', error);
      return null;
    }
  }
}

export default new PayoutProcessorService();