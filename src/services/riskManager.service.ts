import prisma from '../config/database';
import { subDays, subHours, differenceInHours, differenceInDays } from 'date-fns';

enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

interface RiskAssessment {
  riskScore: number; // 0-100
  riskLevel: RiskLevel;
  riskFactors: string[];
  recommendedActions: string[];
  autoBlock: boolean;
  confidence: number; // 0-1
  fraudProbability: number; // 0-1
}

interface TransactionData {
  userId: string;
  amount: number;
  appointmentTime: Date;
  consultationType: string;
  ipAddress?: string;
  userAgent?: string;
  paymentMethod?: string;
  isFirstTime?: boolean;
  deviceFingerprint?: string;
}

interface UserBehaviorPattern {
  userId: string;
  averageBookingValue: number;
  bookingFrequency: number; // bookings per week
  cancelationRate: number; // 0-1
  typicalBookingTime: number; // hours from now
  preferredConsultationType: string;
  riskHistory: {
    totalAssessments: number;
    averageRiskScore: number;
    flaggedTransactions: number;
  };
}

interface FraudIndicator {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  score: number; // 0-100
  autoBlock: boolean;
}

class RiskManagerService {

  /**
   * Calculate comprehensive risk score for a transaction
   */
  async calculateRiskScore(transactionData: TransactionData): Promise<RiskAssessment> {
    try {
      const {
        userId,
        amount,
        appointmentTime,
        consultationType,
        ipAddress,
        userAgent,
        paymentMethod,
        isFirstTime = false,
        deviceFingerprint
      } = transactionData;

      let riskScore = 0;
      const riskFactors: string[] = [];
      const recommendedActions: string[] = [];
      let autoBlock = false;

      // Get user behavior pattern
      const userPattern = await this.getUserBehaviorPattern(userId);

      // 1. Amount-based risk assessment
      const amountRisk = this.assessAmountRisk(amount, userPattern);
      riskScore += amountRisk.score;
      if (amountRisk.factors.length > 0) {
        riskFactors.push(...amountRisk.factors);
      }

      // 2. User behavior risk assessment
      const behaviorRisk = await this.assessUserBehaviorRisk(userId, transactionData);
      riskScore += behaviorRisk.score;
      if (behaviorRisk.factors.length > 0) {
        riskFactors.push(...behaviorRisk.factors);
      }

      // 3. Timing-based risk assessment
      const timingRisk = this.assessTimingRisk(appointmentTime, userPattern);
      riskScore += timingRisk.score;
      if (timingRisk.factors.length > 0) {
        riskFactors.push(...timingRisk.factors);
      }

      // 4. Device and location risk assessment
      if (ipAddress || deviceFingerprint) {
        const deviceRisk = await this.assessDeviceRisk(userId, ipAddress, deviceFingerprint);
        riskScore += deviceRisk.score;
        if (deviceRisk.factors.length > 0) {
          riskFactors.push(...deviceRisk.factors);
        }
      }

      // 5. Payment method risk assessment
      if (paymentMethod) {
        const paymentRisk = await this.assessPaymentMethodRisk(userId, paymentMethod);
        riskScore += paymentRisk.score;
        if (paymentRisk.factors.length > 0) {
          riskFactors.push(...paymentRisk.factors);
        }
      }

      // 6. First-time user risk assessment
      if (isFirstTime) {
        const firstTimeRisk = this.assessFirstTimeUserRisk(amount);
        riskScore += firstTimeRisk.score;
        if (firstTimeRisk.factors.length > 0) {
          riskFactors.push(...firstTimeRisk.factors);
        }
      }

      // 7. Recent activity risk assessment
      const activityRisk = await this.assessRecentActivityRisk(userId);
      riskScore += activityRisk.score;
      if (activityRisk.factors.length > 0) {
        riskFactors.push(...activityRisk.factors);
      }

      // Determine risk level and actions
      const riskLevel = this.determineRiskLevel(riskScore);
      const actions = this.getRecommendedActions(riskLevel, riskFactors);

      // Auto-block for critical risk
      if (riskLevel === RiskLevel.CRITICAL) {
        autoBlock = true;
        recommendedActions.push('IMMEDIATE_BLOCK');
      }

      // Calculate confidence and fraud probability
      const confidence = this.calculateConfidence(riskFactors.length, userPattern);
      const fraudProbability = Math.min(riskScore / 100, 1);

      return {
        riskScore: Math.min(riskScore, 100),
        riskLevel,
        riskFactors,
        recommendedActions: actions,
        autoBlock,
        confidence,
        fraudProbability
      };

    } catch (error) {
      console.error('Risk calculation error:', error);
      // Return safe default for high risk on error
      return {
        riskScore: 75,
        riskLevel: RiskLevel.HIGH,
        riskFactors: ['Risk calculation error - manual review required'],
        recommendedActions: ['MANUAL_REVIEW'],
        autoBlock: false,
        confidence: 0.5,
        fraudProbability: 0.75
      };
    }
  }

  /**
   * Handle risk assessment response
   */
  async handleRiskAssessment(
    assessment: RiskAssessment,
    transactionId: string,
    userId: string
  ): Promise<{
    action: string;
    blocked: boolean;
    requiresVerification: boolean;
    monitoring: boolean;
  }> {
    try {
      let action = 'APPROVE';
      let blocked = false;
      let requiresVerification = false;
      let monitoring = false;

      switch (assessment.riskLevel) {
        case RiskLevel.CRITICAL:
          action = 'BLOCK';
          blocked = true;
          await this.blockTransaction(transactionId, userId, assessment);
          await this.notifySecurityTeam(assessment, transactionId);
          break;

        case RiskLevel.HIGH:
          action = 'REQUIRE_VERIFICATION';
          requiresVerification = true;
          await this.requireAdditionalVerification(transactionId, userId);
          await this.increaseMonitoring(userId);
          break;

        case RiskLevel.MEDIUM:
          action = 'MONITOR';
          monitoring = true;
          await this.flagForReview(transactionId, assessment);
          await this.increaseMonitoring(userId);
          break;

        case RiskLevel.LOW:
          action = 'APPROVE';
          break;
      }

      // Log risk assessment
      await this.logRiskAssessment(transactionId, userId, assessment, action);

      return {
        action,
        blocked,
        requiresVerification,
        monitoring
      };

    } catch (error) {
      console.error('Risk handling error:', error);
      // Default to safe action
      return {
        action: 'MANUAL_REVIEW',
        blocked: false,
        requiresVerification: true,
        monitoring: true
      };
    }
  }

  /**
   * Get user behavior pattern
   */
  private async getUserBehaviorPattern(userId: string): Promise<UserBehaviorPattern> {
    try {
      // Get user's historical appointments
      const appointments = await prisma.appointment.findMany({
        where: {
          clientId: userId,
          createdAt: { gte: subDays(new Date(), 90) } // Last 90 days
        },
        include: {
          payment: true
        }
      });

      if (appointments.length === 0) {
        return {
          userId,
          averageBookingValue: 0,
          bookingFrequency: 0,
          cancelationRate: 0,
          typicalBookingTime: 0,
          preferredConsultationType: 'VIDEO',
          riskHistory: {
            totalAssessments: 0,
            averageRiskScore: 0,
            flaggedTransactions: 0
          }
        };
      }

      // Calculate metrics
      const totalValue = appointments.reduce((sum, apt) => sum + (apt.payment?.totalAmount || 0), 0);
      const averageBookingValue = totalValue / appointments.length;

      const weeksSinceFirst = Math.max(1, differenceInDays(new Date(), appointments[0].createdAt) / 7);
      const bookingFrequency = appointments.length / weeksSinceFirst;

      const cancelledCount = appointments.filter(apt => apt.status === 'CANCELLED').length;
      const cancelationRate = cancelledCount / appointments.length;

      // Calculate typical booking advance time
      const advanceTimes = appointments.map(apt =>
        differenceInHours(apt.startTime, apt.createdAt)
      );
      const typicalBookingTime = advanceTimes.reduce((sum, time) => sum + time, 0) / advanceTimes.length;

      // Most preferred consultation type
      const typeCount = appointments.reduce((count: any, apt) => {
        count[apt.consultationType] = (count[apt.consultationType] || 0) + 1;
        return count;
      }, {});
      const preferredConsultationType = Object.keys(typeCount).reduce((a, b) =>
        typeCount[a] > typeCount[b] ? a : b
      );

      return {
        userId,
        averageBookingValue,
        bookingFrequency,
        cancelationRate,
        typicalBookingTime,
        preferredConsultationType,
        riskHistory: {
          totalAssessments: 0, // Would be calculated from risk assessment logs
          averageRiskScore: 0,
          flaggedTransactions: 0
        }
      };

    } catch (error) {
      console.error('User pattern analysis error:', error);
      return {
        userId,
        averageBookingValue: 0,
        bookingFrequency: 0,
        cancelationRate: 0,
        typicalBookingTime: 0,
        preferredConsultationType: 'VIDEO',
        riskHistory: {
          totalAssessments: 0,
          averageRiskScore: 0,
          flaggedTransactions: 0
        }
      };
    }
  }

  /**
   * Assess amount-based risk
   */
  private assessAmountRisk(amount: number, userPattern: UserBehaviorPattern): {
    score: number;
    factors: string[];
  } {
    let score = 0;
    const factors: string[] = [];

    // High value transaction risk
    if (amount > 500) {
      score += 15;
      factors.push(`High value transaction: ${amount} AZN`);
    }

    // Unusual amount compared to user's pattern
    if (userPattern.averageBookingValue > 0) {
      const amountRatio = amount / userPattern.averageBookingValue;
      if (amountRatio > 3) {
        score += 20;
        factors.push(`Amount ${amountRatio.toFixed(1)}x higher than user average`);
      } else if (amountRatio > 2) {
        score += 10;
        factors.push(`Amount significantly higher than user average`);
      }
    }

    // Very low amounts might indicate testing
    if (amount < 20) {
      score += 5;
      factors.push('Unusually low transaction amount');
    }

    return { score, factors };
  }

  /**
   * Assess user behavior risk
   */
  private async assessUserBehaviorRisk(userId: string, transactionData: TransactionData): Promise<{
    score: number;
    factors: string[];
  }> {
    let score = 0;
    const factors: string[] = [];

    try {
      // Check for rapid successive bookings
      const recentBookings = await prisma.appointment.count({
        where: {
          clientId: userId,
          createdAt: { gte: subHours(new Date(), 1) }
        }
      });

      if (recentBookings > 3) {
        score += 25;
        factors.push(`${recentBookings} bookings in last hour`);
      } else if (recentBookings > 1) {
        score += 10;
        factors.push('Multiple bookings in short time');
      }

      // Check for recently cancelled appointments
      const recentCancellations = await prisma.appointment.count({
        where: {
          clientId: userId,
          status: 'CANCELLED',
          cancelledAt: { gte: subDays(new Date(), 7) }
        }
      });

      if (recentCancellations > 2) {
        score += 15;
        factors.push(`${recentCancellations} cancellations in last week`);
      }

      // Check for failed payments
      const failedPayments = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          status: 'FAILED',
          createdAt: { gte: subDays(new Date(), 30) }
        }
      });

      if (failedPayments > 2) {
        score += 20;
        factors.push(`${failedPayments} failed payments in last month`);
      }

    } catch (error) {
      console.error('User behavior risk assessment error:', error);
      score += 10;
      factors.push('Unable to assess user behavior history');
    }

    return { score, factors };
  }

  /**
   * Assess timing-based risk
   */
  private assessTimingRisk(appointmentTime: Date, userPattern: UserBehaviorPattern): {
    score: number;
    factors: string[];
  } {
    let score = 0;
    const factors: string[] = [];

    const hoursFromNow = differenceInHours(appointmentTime, new Date());

    // Very short notice booking
    if (hoursFromNow < 2) {
      score += 25;
      factors.push('Extremely short notice booking (< 2 hours)');
    } else if (hoursFromNow < 24) {
      score += 15;
      factors.push('Same day booking');
    }

    // Unusual booking time compared to user pattern
    if (userPattern.typicalBookingTime > 0) {
      const timingRatio = Math.abs(hoursFromNow - userPattern.typicalBookingTime) / userPattern.typicalBookingTime;
      if (timingRatio > 2) {
        score += 10;
        factors.push('Unusual booking advance time for user');
      }
    }

    // Very far future booking
    if (hoursFromNow > 30 * 24) {
      score += 10;
      factors.push('Booking very far in future (>30 days)');
    }

    return { score, factors };
  }

  /**
   * Assess device and location risk
   */
  private async assessDeviceRisk(userId: string, ipAddress?: string, deviceFingerprint?: string): Promise<{
    score: number;
    factors: string[];
  }> {
    let score = 0;
    const factors: string[] = [];

    try {
      if (ipAddress) {
        // Check for IP address changes
        const recentPayments = await prisma.payment.findMany({
          where: {
            appointment: { clientId: userId },
            createdAt: { gte: subDays(new Date(), 7) }
          },
          select: { ipAddress: true }
        });

        const uniqueIPs = new Set(recentPayments.map(p => p.ipAddress).filter(Boolean));
        if (uniqueIPs.size > 3) {
          score += 15;
          factors.push(`Multiple IP addresses used (${uniqueIPs.size})`);
        }

        // Check for suspicious IP patterns (would integrate with IP intelligence service)
        if (this.isSuspiciousIP(ipAddress)) {
          score += 30;
          factors.push('Suspicious IP address detected');
        }
      }

      // Device fingerprint analysis (if available)
      if (deviceFingerprint) {
        // Check if device fingerprint has changed
        const lastPayment = await prisma.payment.findFirst({
          where: {
            appointment: { clientId: userId }
          },
          orderBy: { createdAt: 'desc' }
        });

        // For now, just add placeholder logic
        // In production, you would compare device fingerprints
      }

    } catch (error) {
      console.error('Device risk assessment error:', error);
    }

    return { score, factors };
  }

  /**
   * Assess payment method risk
   */
  private async assessPaymentMethodRisk(userId: string, paymentMethod: string): Promise<{
    score: number;
    factors: string[];
  }> {
    let score = 0;
    const factors: string[] = [];

    try {
      // Check for frequent payment method changes
      const recentMethods = await prisma.payment.findMany({
        where: {
          appointment: { clientId: userId },
          createdAt: { gte: subDays(new Date(), 30) }
        },
        select: { paymentMethod: true }
      });

      const uniqueMethods = new Set(recentMethods.map(p => p.paymentMethod).filter(Boolean));
      if (uniqueMethods.size > 2) {
        score += 10;
        factors.push('Multiple payment methods used recently');
      }

      // Risk based on payment method type
      switch (paymentMethod.toLowerCase()) {
        case 'prepaid_card':
          score += 20;
          factors.push('Prepaid card payment method');
          break;
        case 'crypto':
          score += 30;
          factors.push('Cryptocurrency payment method');
          break;
        case 'bank_transfer':
          score += 5;
          factors.push('Bank transfer method (lower risk)');
          break;
      }

    } catch (error) {
      console.error('Payment method risk assessment error:', error);
    }

    return { score, factors };
  }

  /**
   * Assess first-time user risk
   */
  private assessFirstTimeUserRisk(amount: number): {
    score: number;
    factors: string[];
  } {
    let score = 10; // Base score for new users
    const factors: string[] = ['First-time user'];

    // Higher risk for high-value first transactions
    if (amount > 300) {
      score += 20;
      factors.push('High-value first transaction');
    } else if (amount > 150) {
      score += 10;
      factors.push('Moderate-value first transaction');
    }

    return { score, factors };
  }

  /**
   * Assess recent activity risk
   */
  private async assessRecentActivityRisk(userId: string): Promise<{
    score: number;
    factors: string[];
  }> {
    let score = 0;
    const factors: string[] = [];

    try {
      // Check for account creation recency
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (user) {
        const accountAgeDays = differenceInDays(new Date(), user.createdAt);
        if (accountAgeDays < 1) {
          score += 25;
          factors.push('Very new account (< 1 day)');
        } else if (accountAgeDays < 7) {
          score += 15;
          factors.push('New account (< 1 week)');
        } else if (accountAgeDays < 30) {
          score += 5;
          factors.push('Recent account (< 1 month)');
        }
      }

      // Check for rapid activity after account creation
      if (user) {
        const appointmentCount = await prisma.appointment.count({
          where: { clientId: userId }
        });

        const accountAgeDays = Math.max(1, differenceInDays(new Date(), user.createdAt));
        const appointmentsPerDay = appointmentCount / accountAgeDays;

        if (appointmentsPerDay > 2) {
          score += 20;
          factors.push('Unusually high activity rate for account age');
        }
      }

    } catch (error) {
      console.error('Recent activity risk assessment error:', error);
    }

    return { score, factors };
  }

  /**
   * Determine risk level from score
   */
  private determineRiskLevel(score: number): RiskLevel {
    if (score >= 80) return RiskLevel.CRITICAL;
    if (score >= 60) return RiskLevel.HIGH;
    if (score >= 30) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /**
   * Get recommended actions for risk level
   */
  private getRecommendedActions(riskLevel: RiskLevel, riskFactors: string[]): string[] {
    const actions: string[] = [];

    switch (riskLevel) {
      case RiskLevel.CRITICAL:
        actions.push('BLOCK_TRANSACTION', 'MANUAL_REVIEW', 'INVESTIGATE_USER', 'NOTIFY_SECURITY_TEAM');
        break;
      case RiskLevel.HIGH:
        actions.push('REQUIRE_VERIFICATION', 'MANUAL_REVIEW', 'INCREASE_MONITORING');
        break;
      case RiskLevel.MEDIUM:
        actions.push('FLAG_FOR_REVIEW', 'INCREASE_MONITORING');
        break;
      case RiskLevel.LOW:
        actions.push('APPROVE');
        break;
    }

    return actions;
  }

  /**
   * Calculate confidence in risk assessment
   */
  private calculateConfidence(factorCount: number, userPattern: UserBehaviorPattern): number {
    let confidence = 0.5; // Base confidence

    // More factors = higher confidence
    confidence += Math.min(factorCount * 0.1, 0.3);

    // More user history = higher confidence
    if (userPattern.riskHistory.totalAssessments > 10) {
      confidence += 0.2;
    } else if (userPattern.riskHistory.totalAssessments > 5) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Check if IP address is suspicious (placeholder)
   */
  private isSuspiciousIP(ipAddress: string): boolean {
    // In production, this would integrate with IP intelligence services
    // For now, return false as placeholder
    return false;
  }

  /**
   * Block transaction
   */
  private async blockTransaction(transactionId: string, userId: string, assessment: RiskAssessment): Promise<void> {
    try {
      console.log(`TRANSACTION BLOCKED: ${transactionId} for user ${userId}`, {
        riskScore: assessment.riskScore,
        riskLevel: assessment.riskLevel,
        factors: assessment.riskFactors
      });
      // In production, update transaction status to blocked
    } catch (error) {
      console.error('Block transaction error:', error);
    }
  }

  /**
   * Notify security team
   */
  private async notifySecurityTeam(assessment: RiskAssessment, transactionId: string): Promise<void> {
    try {
      console.log(`SECURITY ALERT: High risk transaction ${transactionId}`, assessment);
      // In production, send alerts to security team
    } catch (error) {
      console.error('Security notification error:', error);
    }
  }

  /**
   * Require additional verification
   */
  private async requireAdditionalVerification(transactionId: string, userId: string): Promise<void> {
    try {
      console.log(`VERIFICATION REQUIRED: Transaction ${transactionId} for user ${userId}`);
      // In production, trigger additional verification flow
    } catch (error) {
      console.error('Verification requirement error:', error);
    }
  }

  /**
   * Increase monitoring for user
   */
  private async increaseMonitoring(userId: string): Promise<void> {
    try {
      console.log(`MONITORING INCREASED: User ${userId}`);
      // In production, flag user for increased monitoring
    } catch (error) {
      console.error('Increase monitoring error:', error);
    }
  }

  /**
   * Flag transaction for review
   */
  private async flagForReview(transactionId: string, assessment: RiskAssessment): Promise<void> {
    try {
      console.log(`FLAGGED FOR REVIEW: Transaction ${transactionId}`, {
        riskScore: assessment.riskScore,
        factors: assessment.riskFactors
      });
      // In production, add to review queue
    } catch (error) {
      console.error('Flag for review error:', error);
    }
  }

  /**
   * Log risk assessment
   */
  private async logRiskAssessment(
    transactionId: string,
    userId: string,
    assessment: RiskAssessment,
    action: string
  ): Promise<void> {
    try {
      console.log(`RISK ASSESSMENT LOG:`, {
        transactionId,
        userId,
        riskScore: assessment.riskScore,
        riskLevel: assessment.riskLevel,
        action,
        timestamp: new Date().toISOString()
      });
      // In production, store in audit log
    } catch (error) {
      console.error('Risk assessment logging error:', error);
    }
  }
}

export default new RiskManagerService();