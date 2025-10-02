import prisma from '../config/database';
import pricingEngineService from './pricingEngine.service';
import escrowManagerService from './escrowManager.service';
import fraudDetectionService from './fraudDetection.service';

// Temporary enums until Prisma client is regenerated
export enum TempPaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED'
}

export enum TempPaymentProvider {
  STRIPE = 'STRIPE',
  KAPITAL_BANK = 'KAPITAL_BANK',
  AZERBAIJAN_POSTAL_BANK = 'AZERBAIJAN_POSTAL_BANK',
  PASHABANK = 'PASHABANK',
  PAYPAL = 'PAYPAL',
  LOCAL_TRANSFER = 'LOCAL_TRANSFER'
}

interface PaymentInitiationParams {
  appointmentId: string;
  userId: string;
  provider: TempPaymentProvider;
  currency?: string;
  clientLocation?: string;
  ipAddress?: string;
  userAgent?: string;
}

interface PaymentConfirmationParams {
  paymentId: string;
  providerTransactionId: string;
  paymentIntentId?: string;
  paymentMethod?: string;
  lastFourDigits?: string;
  expiryDate?: string;
}

interface PaymentResult {
  success: boolean;
  paymentId?: string;
  paymentReference?: string;
  totalAmount?: number;
  currency?: string;
  error?: string;
  riskAssessment?: any;
  requiresAction?: boolean;
  actionUrl?: string;
}

interface RefundParams {
  paymentId: string;
  amount?: number; // If not provided, full refund
  reason: string;
  refundType: 'full' | 'partial' | 'cancellation_policy' | 'dispute';
  initiatedBy: string;
}

class PaymentProcessorService {
  /**
   * Calculate cost for consultation
   */
  async calculateCost(
    lawyerId: string,
    duration: number,
    appointmentTime: Date,
    consultationType: string,
    isUrgent: boolean = false,
    clientLocation?: string,
    currency: string = 'AZN'
  ): Promise<any> {
    try {
      const calculation = await pricingEngineService.calculateConsultationCost(
        lawyerId,
        duration,
        appointmentTime,
        consultationType as any,
        isUrgent,
        clientLocation,
        currency
      );

      return {
        success: true,
        data: {
          baseAmount: calculation.baseAmount,
          modifiers: calculation.modifiers,
          subtotal: calculation.subtotal,
          platformFee: calculation.platformFee,
          taxes: calculation.taxes,
          totalAmount: calculation.totalAmount,
          lawyerReceives: calculation.lawyerReceives,
          platformKeeps: calculation.platformKeeps,
          currency: calculation.currency,
          breakdown: calculation.breakdown,
          summary: pricingEngineService.formatPricingSummary(calculation)
        }
      };

    } catch (error) {
      console.error('Cost calculation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to calculate cost'
      };
    }
  }

  /**
   * Initiate payment process
   */
  async initiatePayment(params: PaymentInitiationParams): Promise<PaymentResult> {
    try {
      const { appointmentId, userId, provider, currency = 'AZN', clientLocation, ipAddress, userAgent } = params;

      // Get appointment details
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          client: true,
          lawyer: {
            include: { user: true }
          }
        }
      });

      if (!appointment) {
        return { success: false, error: 'Appointment not found' };
      }

      // Verify user authorization
      if (appointment.clientId !== userId) {
        return { success: false, error: 'Unauthorized payment attempt' };
      }

      // Calculate pricing
      const pricingResult = await this.calculateCost(
        appointment.lawyerId,
        appointment.consultationDuration,
        appointment.startTime,
        appointment.consultationType,
        false, // isUrgent - could be determined from appointment
        clientLocation,
        currency
      );

      if (!pricingResult.success) {
        return { success: false, error: 'Failed to calculate pricing' };
      }

      const pricing = pricingResult.data;

      // Run fraud detection
      const riskAssessment = await fraudDetectionService.assessRisk({
        userId,
        appointmentId,
        amount: pricing.totalAmount,
        currency,
        provider,
        ipAddress,
        userAgent,
        paymentMethod: 'card' // Default, could be dynamic
      });

      // Block high-risk transactions
      if (riskAssessment.riskLevel === 'CRITICAL' && riskAssessment.autoBlock) {
        return {
          success: false,
          error: 'Payment blocked due to high risk score',
          riskAssessment
        };
      }

      // Generate payment reference
      const paymentReference = this.generatePaymentReference();

      // Create payment record
      const payment = await prisma.payment.create({
        data: {
          appointmentId,
          paymentReference,
          baseAmount: pricing.subtotal,
          platformFee: pricing.platformFee,
          taxes: pricing.taxes,
          totalAmount: pricing.totalAmount,
          currency: currency as any,
          status: TempPaymentStatus.PENDING,
          provider,
          riskScore: riskAssessment.riskScore,
          riskLevel: riskAssessment.riskLevel as any,
          riskFactors: riskAssessment.riskFactors,
          ipAddress,
          userAgent
        }
      });

      // Log payment initiation
      await this.logPaymentAction(payment.id, 'initiated', userId, 'Payment initiated', {
        provider,
        amount: pricing.totalAmount,
        currency,
        riskScore: riskAssessment.riskScore
      });

      return {
        success: true,
        paymentId: payment.id,
        paymentReference: payment.paymentReference,
        totalAmount: pricing.totalAmount,
        currency,
        riskAssessment,
        requiresAction: riskAssessment.riskLevel === 'HIGH' // Might require additional verification
      };

    } catch (error) {
      console.error('Payment initiation error:', error);
      return {
        success: false,
        error: 'Failed to initiate payment'
      };
    }
  }

  /**
   * Confirm payment authorization from external provider
   */
  async confirmPayment(params: PaymentConfirmationParams): Promise<PaymentResult> {
    try {
      const {
        paymentId,
        providerTransactionId,
        paymentIntentId,
        paymentMethod,
        lastFourDigits,
        expiryDate
      } = params;

      // Get payment record
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
        return { success: false, error: 'Payment not found' };
      }

      if (payment.status !== TempPaymentStatus.PENDING) {
        return { success: false, error: `Payment already ${payment.status.toLowerCase()}` };
      }

      // Update payment record
      const updatedPayment = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: TempPaymentStatus.AUTHORIZED,
          providerTransactionId,
          paymentIntentId,
          paymentMethod,
          lastFourDigits,
          expiryDate,
          authorizedAt: new Date()
        }
      });

      // Hold funds in escrow
      const escrowResult = await escrowManagerService.holdFunds({
        paymentId,
        totalAmount: payment.totalAmount,
        lawyerAmount: payment.totalAmount - payment.platformFee - payment.taxes,
        platformAmount: payment.platformFee + payment.taxes
      });

      if (!escrowResult.success) {
        console.error('Escrow hold failed:', escrowResult.error);
        // Don't fail the payment, but log the issue
      }

      // Update appointment status
      await prisma.appointment.update({
        where: { id: payment.appointmentId },
        data: {
          status: 'CONFIRMED',
          paymentStatus: TempPaymentStatus.AUTHORIZED
        }
      });

      // Log confirmation
      await this.logPaymentAction(paymentId, 'authorized', 'system', 'Payment authorized', {
        providerTransactionId,
        amount: payment.totalAmount,
        escrowId: escrowResult.escrowId
      });

      // TODO: Send confirmation notifications
      // TODO: Create calendar events

      return {
        success: true,
        paymentId: updatedPayment.id,
        paymentReference: updatedPayment.paymentReference,
        totalAmount: updatedPayment.totalAmount,
        currency: updatedPayment.currency
      };

    } catch (error) {
      console.error('Payment confirmation error:', error);
      return {
        success: false,
        error: 'Failed to confirm payment'
      };
    }
  }

  /**
   * Capture payment after consultation completion
   */
  async capturePayment(paymentId: string, capturedBy: string): Promise<PaymentResult> {
    try {
      // Get payment record
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          appointment: true,
          escrow: true
        }
      });

      if (!payment) {
        return { success: false, error: 'Payment not found' };
      }

      if (payment.status !== TempPaymentStatus.AUTHORIZED) {
        return { success: false, error: `Cannot capture payment with status: ${payment.status}` };
      }

      // Verify consultation is completed
      if (payment.appointment.status !== 'COMPLETED') {
        return { success: false, error: 'Cannot capture payment before consultation completion' };
      }

      // Update payment status
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: TempPaymentStatus.CAPTURED,
          capturedAt: new Date()
        }
      });

      // Release funds from escrow
      if (payment.escrow) {
        await escrowManagerService.releaseFunds({
          paymentId,
          releaseType: 'full',
          reason: 'Consultation completed successfully',
          releasedBy: capturedBy
        });
      }

      // Log capture
      await this.logPaymentAction(paymentId, 'captured', capturedBy, 'Payment captured after consultation', {
        amount: payment.totalAmount,
        consultationCompleted: payment.appointment.consultationEndedAt
      });

      return {
        success: true,
        paymentId,
        paymentReference: payment.paymentReference,
        totalAmount: payment.totalAmount,
        currency: payment.currency
      };

    } catch (error) {
      console.error('Payment capture error:', error);
      return {
        success: false,
        error: 'Failed to capture payment'
      };
    }
  }

  /**
   * Process refund
   */
  async processRefund(params: RefundParams): Promise<PaymentResult> {
    try {
      const { paymentId, amount, reason, refundType, initiatedBy } = params;

      // Get payment record
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          appointment: {
            include: {
              lawyer: { include: { bookingPolicy: true } }
            }
          },
          refunds: true
        }
      });

      if (!payment) {
        return { success: false, error: 'Payment not found' };
      }

      // Calculate refund amount based on cancellation policy
      let refundAmount = amount || payment.totalAmount;

      if (refundType === 'cancellation_policy') {
        const cancelPolicyResult = await this.calculateCancellationRefund(payment);
        refundAmount = cancelPolicyResult.refundAmount;
      }

      // Check if refund amount is valid
      const totalRefunded = payment.refunds.reduce((sum, refund) =>
        refund.status === 'PROCESSED' ? sum + refund.amount : sum, 0
      );

      if (totalRefunded + refundAmount > payment.totalAmount) {
        return { success: false, error: 'Refund amount exceeds payment total' };
      }

      // Generate refund reference
      const refundReference = this.generateRefundReference(payment.paymentReference);

      // Create refund record
      const refund = await prisma.refund.create({
        data: {
          paymentId,
          refundReference,
          amount: refundAmount,
          reason,
          refundType,
          status: 'PENDING',
          expectedSettlement: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) // 3 days
        }
      });

      // Update payment status
      const newPaymentStatus = (totalRefunded + refundAmount >= payment.totalAmount)
        ? TempPaymentStatus.REFUNDED
        : TempPaymentStatus.PARTIALLY_REFUNDED;

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: newPaymentStatus,
          refundedAt: new Date()
        }
      });

      // Update appointment if full refund
      if (newPaymentStatus === TempPaymentStatus.REFUNDED) {
        await prisma.appointment.update({
          where: { id: payment.appointmentId },
          data: {
            refundAmount: refundAmount,
            refundStatus: 'PROCESSED'
          }
        });
      }

      // Log refund
      await this.logPaymentAction(paymentId, 'refunded', initiatedBy, `${refundType} refund processed`, {
        refundId: refund.id,
        refundAmount,
        reason,
        refundType
      });

      // TODO: Process actual refund with payment provider

      return {
        success: true,
        paymentId,
        paymentReference: payment.paymentReference,
        totalAmount: refundAmount,
        currency: payment.currency
      };

    } catch (error) {
      console.error('Refund processing error:', error);
      return {
        success: false,
        error: 'Failed to process refund'
      };
    }
  }

  /**
   * Calculate cancellation refund based on policy
   */
  private async calculateCancellationRefund(payment: any): Promise<{ refundAmount: number; explanation: string }> {
    const appointment = payment.appointment;
    const policy = appointment.lawyer.bookingPolicy;

    if (!policy) {
      return { refundAmount: payment.totalAmount, explanation: 'No cancellation policy, full refund' };
    }

    const now = new Date();
    const hoursUntilAppointment = (appointment.startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntilAppointment >= policy.freeCancellationHours) {
      return {
        refundAmount: payment.totalAmount,
        explanation: `Free cancellation (${hoursUntilAppointment.toFixed(1)}h before appointment)`
      };
    } else if (hoursUntilAppointment >= policy.noCancellationHours) {
      const refundPercentage = 100 - policy.cancellationFeePercentage;
      const refundAmount = payment.totalAmount * (refundPercentage / 100);
      return {
        refundAmount,
        explanation: `${refundPercentage}% refund (${policy.cancellationFeePercentage}% cancellation fee)`
      };
    } else {
      return {
        refundAmount: 0,
        explanation: `No refund (cancelled within ${policy.noCancellationHours}h of appointment)`
      };
    }
  }

  /**
   * Generate unique payment reference
   */
  private generatePaymentReference(): string {
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `PAY-${timestamp}-${random}`;
  }

  /**
   * Generate refund reference
   */
  private generateRefundReference(paymentReference: string): string {
    const timestamp = Date.now().toString().slice(-6);
    return `REF-${paymentReference.split('-')[1]}-${timestamp}`;
  }

  /**
   * Log payment actions for audit trail
   */
  private async logPaymentAction(
    paymentId: string,
    action: string,
    performedBy: string,
    reason: string,
    metadata: any
  ): Promise<void> {
    try {
      await prisma.paymentAuditLog.create({
        data: {
          paymentId,
          action,
          performedBy,
          reason,
          beforeState: {}, // Could store previous payment state
          afterState: metadata,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent
        }
      });
    } catch (error) {
      console.error('Failed to log payment action:', error);
    }
  }

  /**
   * Get payment status and history
   */
  async getPaymentStatus(paymentId: string): Promise<any> {
    try {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
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
          },
          escrow: true,
          refunds: true,
          auditLogs: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      return payment;
    } catch (error) {
      console.error('Get payment status error:', error);
      return null;
    }
  }
}

export default new PaymentProcessorService();