import prisma from '../config/database';
import { EscrowStatus, PaymentStatus } from '@prisma/client';

// Temporary enums until Prisma client is regenerated
enum TempEscrowStatus {
  HELD = 'HELD',
  RELEASED_TO_LAWYER = 'RELEASED_TO_LAWYER',
  RELEASED_TO_CLIENT = 'RELEASED_TO_CLIENT',
  PARTIAL_RELEASE = 'PARTIAL_RELEASE',
  DISPUTED = 'DISPUTED'
}

interface EscrowHoldParams {
  paymentId: string;
  totalAmount: number;
  lawyerAmount: number;
  platformAmount: number;
  autoReleaseHours?: number; // Auto-release after consultation + buffer
}

interface EscrowReleaseParams {
  paymentId: string;
  releaseType: 'full' | 'partial' | 'dispute_resolution';
  amount?: number; // For partial releases
  reason: string;
  releasedBy: string; // user ID
}

interface EscrowCalculation {
  lawyerAmount: number;
  platformAmount: number;
  refundAmount: number;
  totalVerified: number;
}

interface EscrowDispute {
  disputeId: string;
  freezeReason: string;
  initiatedBy: string;
}

class EscrowManagerService {
  private readonly PLATFORM_FEE_PERCENTAGE = 0.15; // 15%
  private readonly AUTO_RELEASE_BUFFER_HOURS = 24; // 24 hours after consultation completion

  /**
   * Hold funds in escrow after payment authorization
   */
  async holdFunds(params: EscrowHoldParams): Promise<{ success: boolean; escrowId?: string; error?: string }> {
    try {
      const { paymentId, totalAmount, lawyerAmount, platformAmount, autoReleaseHours = 24 } = params;

      // Verify payment exists and is authorized
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { appointment: true }
      });

      if (!payment) {
        return { success: false, error: 'Payment not found' };
      }

      if (payment.status !== 'AUTHORIZED') {
        return { success: false, error: 'Payment must be authorized before escrow hold' };
      }

      // Calculate auto-release time
      const consultationEnd = payment.appointment.endTime;
      const autoReleaseAt = new Date(consultationEnd.getTime() + (autoReleaseHours * 60 * 60 * 1000));

      // Create escrow record
      const escrowRecord = await prisma.escrowRecord.create({
        data: {
          paymentId,
          totalAmount,
          lawyerAmount,
          platformAmount,
          heldAmount: totalAmount,
          releasedAmount: 0,
          status: TempEscrowStatus.HELD,
          autoReleaseAt
        }
      });

      // Log the escrow action
      await this.logEscrowAction(
        escrowRecord.id,
        'funds_held',
        'system',
        `Funds held in escrow: ${totalAmount} AZN`,
        { totalAmount, lawyerAmount, platformAmount, autoReleaseAt }
      );

      return { success: true, escrowId: escrowRecord.id };

    } catch (error) {
      console.error('Escrow hold error:', error);
      return { success: false, error: 'Failed to hold funds in escrow' };
    }
  }

  /**
   * Release funds from escrow
   */
  async releaseFunds(params: EscrowReleaseParams): Promise<{ success: boolean; error?: string }> {
    try {
      const { paymentId, releaseType, amount, reason, releasedBy } = params;

      // Get escrow record
      const escrowRecord = await prisma.escrowRecord.findUnique({
        where: { paymentId },
        include: {
          payment: {
            include: { appointment: true }
          }
        }
      });

      if (!escrowRecord) {
        return { success: false, error: 'Escrow record not found' };
      }

      if (escrowRecord.status === TempEscrowStatus.DISPUTED) {
        return { success: false, error: 'Cannot release disputed funds without resolution' };
      }

      let releaseAmount = amount || escrowRecord.heldAmount;
      let newStatus: TempEscrowStatus;
      let releaseData: any = {};

      switch (releaseType) {
        case 'full':
          // Release all funds according to agreed split
          releaseAmount = escrowRecord.heldAmount;
          newStatus = TempEscrowStatus.RELEASED_TO_LAWYER;
          releaseData = {
            lawyerAmount: escrowRecord.lawyerAmount,
            platformAmount: escrowRecord.platformAmount
          };
          break;

        case 'partial':
          if (!amount || amount > escrowRecord.heldAmount) {
            return { success: false, error: 'Invalid partial release amount' };
          }
          newStatus = TempEscrowStatus.PARTIAL_RELEASE;
          releaseAmount = amount;
          break;

        case 'dispute_resolution':
          // Handle dispute resolution releases
          newStatus = TempEscrowStatus.RELEASED_TO_CLIENT; // Or split based on resolution
          releaseAmount = escrowRecord.heldAmount;
          break;

        default:
          return { success: false, error: 'Invalid release type' };
      }

      // Update escrow record
      await prisma.escrowRecord.update({
        where: { paymentId },
        data: {
          status: newStatus,
          releasedAmount: { increment: releaseAmount },
          heldAmount: { decrement: releaseAmount },
          releasedAt: new Date(),
          releaseReason: reason
        }
      });

      // Update payment status if fully released
      if (releaseType === 'full') {
        await prisma.payment.update({
          where: { id: paymentId },
          data: {
            status: 'CAPTURED',
            capturedAt: new Date()
          }
        });
      }

      // Create payout records for lawyer if applicable
      if (releaseType === 'full' && escrowRecord.lawyerAmount > 0) {
        await this.createPayoutRecord(escrowRecord.payment.appointment.lawyerId, escrowRecord.payment.appointmentId, escrowRecord.lawyerAmount);
      }

      // Log the release action
      await this.logEscrowAction(
        escrowRecord.id,
        'funds_released',
        releasedBy,
        `Funds released: ${releaseAmount} AZN (${releaseType})`,
        { releaseAmount, releaseType, reason, ...releaseData }
      );

      return { success: true };

    } catch (error) {
      console.error('Escrow release error:', error);
      return { success: false, error: 'Failed to release funds from escrow' };
    }
  }

  /**
   * Freeze funds due to dispute
   */
  async freezeFunds(params: EscrowDispute): Promise<{ success: boolean; error?: string }> {
    try {
      const { disputeId, freezeReason, initiatedBy } = params;

      // Get dispute to find payment
      const dispute = await prisma.dispute.findUnique({
        where: { id: disputeId },
        include: {
          appointment: {
            include: { payment: true }
          }
        }
      });

      if (!dispute) {
        return { success: false, error: 'Dispute not found' };
      }

      const paymentId = dispute.appointment.payment?.id;
      if (!paymentId) {
        return { success: false, error: 'No payment found for dispute' };
      }

      // Update escrow record
      await prisma.escrowRecord.update({
        where: { paymentId },
        data: {
          status: TempEscrowStatus.DISPUTED,
          disputeId,
          frozenAt: new Date(),
          frozenReason: freezeReason
        }
      });

      // Log the freeze action
      await this.logEscrowAction(
        paymentId,
        'funds_frozen',
        initiatedBy,
        `Funds frozen due to dispute: ${freezeReason}`,
        { disputeId, freezeReason }
      );

      return { success: true };

    } catch (error) {
      console.error('Escrow freeze error:', error);
      return { success: false, error: 'Failed to freeze funds' };
    }
  }

  /**
   * Calculate release amounts
   */
  async calculateRelease(paymentId: string): Promise<EscrowCalculation> {
    try {
      const escrowRecord = await prisma.escrowRecord.findUnique({
        where: { paymentId },
        include: {
          payment: {
            include: { appointment: true }
          }
        }
      });

      if (!escrowRecord) {
        throw new Error('Escrow record not found');
      }

      const totalAmount = escrowRecord.totalAmount;
      const platformFee = totalAmount * this.PLATFORM_FEE_PERCENTAGE;
      const lawyerAmount = totalAmount - platformFee;

      return {
        lawyerAmount,
        platformAmount: platformFee,
        refundAmount: 0, // No refund for completed consultations
        totalVerified: totalAmount
      };

    } catch (error) {
      console.error('Escrow calculation error:', error);
      throw new Error('Failed to calculate escrow release');
    }
  }

  /**
   * Process automatic releases for completed consultations
   */
  async processAutomaticReleases(): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors = 0;

    try {
      // Find escrow records ready for auto-release
      const dueReleases = await prisma.escrowRecord.findMany({
        where: {
          status: TempEscrowStatus.HELD,
          autoReleaseAt: {
            lte: new Date()
          }
        },
        include: {
          payment: {
            include: {
              appointment: {
                include: {
                  lawyer: true,
                  client: true
                }
              }
            }
          }
        }
      });

      for (const escrow of dueReleases) {
        try {
          // Check if consultation was completed
          const appointment = escrow.payment.appointment;
          if (appointment.status === 'COMPLETED') {
            await this.releaseFunds({
              paymentId: escrow.paymentId,
              releaseType: 'full',
              reason: 'Automatic release after consultation completion',
              releasedBy: 'system'
            });
            processed++;
          }
        } catch (error) {
          console.error(`Auto-release error for escrow ${escrow.id}:`, error);
          errors++;
        }
      }

      console.log(`Auto-release processing complete: ${processed} processed, ${errors} errors`);
      return { processed, errors };

    } catch (error) {
      console.error('Auto-release processing error:', error);
      return { processed, errors: errors + 1 };
    }
  }

  /**
   * Get escrow status and details
   */
  async getEscrowStatus(paymentId: string): Promise<any> {
    try {
      const escrowRecord = await prisma.escrowRecord.findUnique({
        where: { paymentId },
        include: {
          payment: {
            include: {
              appointment: {
                include: {
                  client: {
                    select: { id: true, firstName: true, lastName: true, email: true }
                  },
                  lawyer: {
                    include: {
                      user: {
                        select: { id: true, firstName: true, lastName: true, email: true }
                      }
                    }
                  }
                }
              }
            }
          },
          dispute: true
        }
      });

      if (!escrowRecord) {
        return null;
      }

      return {
        id: escrowRecord.id,
        status: escrowRecord.status,
        totalAmount: escrowRecord.totalAmount,
        heldAmount: escrowRecord.heldAmount,
        releasedAmount: escrowRecord.releasedAmount,
        heldAt: escrowRecord.heldAt,
        releasedAt: escrowRecord.releasedAt,
        autoReleaseAt: escrowRecord.autoReleaseAt,
        dispute: escrowRecord.dispute,
        appointment: escrowRecord.payment.appointment
      };

    } catch (error) {
      console.error('Get escrow status error:', error);
      return null;
    }
  }

  /**
   * Create payout record for lawyer
   */
  private async createPayoutRecord(lawyerId: string, appointmentId: string, amount: number): Promise<void> {
    try {
      // Check if payout already exists for this appointment
      const existingPayout = await prisma.payoutItem.findFirst({
        where: { appointmentId }
      });

      if (existingPayout) {
        return; // Already processed
      }

      // Get appointment details
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: true
        }
      });

      if (!appointment) {
        throw new Error('Appointment not found');
      }

      // Find or create pending payout for this lawyer
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1); // Start of current month
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // End of current month

      let payout = await prisma.payout.findFirst({
        where: {
          lawyerId,
          status: 'PENDING',
          periodStart,
          periodEnd
        }
      });

      if (!payout) {
        // Create new payout
        const payoutReference = `PAYOUT-${lawyerId.slice(-6)}-${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}`;

        payout = await prisma.payout.create({
          data: {
            lawyerId,
            payoutReference,
            grossAmount: amount,
            platformFee: amount * this.PLATFORM_FEE_PERCENTAGE,
            taxes: 0, // Calculated later
            netAmount: amount - (amount * this.PLATFORM_FEE_PERCENTAGE),
            periodStart,
            periodEnd,
            appointmentCount: 1,
            status: 'PENDING'
          }
        });
      } else {
        // Update existing payout
        await prisma.payout.update({
          where: { id: payout.id },
          data: {
            grossAmount: { increment: amount },
            platformFee: { increment: amount * this.PLATFORM_FEE_PERCENTAGE },
            netAmount: { increment: amount - (amount * this.PLATFORM_FEE_PERCENTAGE) },
            appointmentCount: { increment: 1 }
          }
        });
      }

      // Create payout item
      await prisma.payoutItem.create({
        data: {
          payoutId: payout.id,
          appointmentId,
          consultationDate: appointment.startTime,
          clientName: `${appointment.client.firstName} ${appointment.client.lastName}`,
          consultationType: appointment.consultationType as any,
          duration: appointment.consultationDuration,
          baseAmount: appointment.baseAmount,
          platformFee: amount * this.PLATFORM_FEE_PERCENTAGE,
          lawyerEarning: amount - (amount * this.PLATFORM_FEE_PERCENTAGE)
        }
      });

    } catch (error) {
      console.error('Create payout record error:', error);
    }
  }

  /**
   * Log escrow actions for audit trail
   */
  private async logEscrowAction(
    escrowId: string,
    action: string,
    performedBy: string,
    description: string,
    metadata: any
  ): Promise<void> {
    try {
      // This would be stored in an audit log table
      console.log(`Escrow Action Log: ${action} on ${escrowId} by ${performedBy} - ${description}`, metadata);

      // You could create an EscrowAuditLog model similar to PaymentAuditLog
      // For now, we'll just log to console
    } catch (error) {
      console.error('Failed to log escrow action:', error);
    }
  }
}

export default new EscrowManagerService();