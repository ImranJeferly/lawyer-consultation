import prisma from '../config/database';
import { RiskLevel } from '@prisma/client';

// Temporary enum until Prisma client is regenerated
enum TempRiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

interface RiskAssessmentParams {
  userId: string;
  appointmentId: string;
  amount: number;
  currency: string;
  provider: string;
  ipAddress?: string;
  userAgent?: string;
  paymentMethod?: string;
  deviceFingerprint?: string;
}

interface RiskAssessmentResult {
  riskScore: number; // 0-100
  riskLevel: TempRiskLevel;
  riskFactors: string[];
  recommendations: string[];
  autoBlock: boolean;
  requiresManualReview: boolean;
  requiresAdditionalVerification: boolean;
}

interface VelocityCheck {
  transactionCount: number;
  totalAmount: number;
  timeWindow: string;
  suspicious: boolean;
}

interface DeviceProfile {
  isNewDevice: boolean;
  deviceTrustScore: number;
  locationConsistency: boolean;
  browserConsistency: boolean;
}

class FraudDetectionService {
  private readonly HIGH_RISK_THRESHOLD = 70;
  private readonly CRITICAL_RISK_THRESHOLD = 85;
  private readonly MAX_HOURLY_TRANSACTIONS = 5;
  private readonly MAX_DAILY_AMOUNT = 5000; // AZN
  private readonly MAX_TRANSACTION_AMOUNT = 1000; // AZN for single consultation

  /**
   * Assess risk for a payment transaction
   */
  async assessRisk(params: RiskAssessmentParams): Promise<RiskAssessmentResult> {
    try {
      const {
        userId,
        appointmentId,
        amount,
        currency,
        provider,
        ipAddress,
        userAgent,
        paymentMethod,
        deviceFingerprint
      } = params;

      let riskScore = 0;
      const riskFactors: string[] = [];
      const recommendations: string[] = [];

      // 1. User behavior analysis (25 points max)
      const userRisk = await this.analyzeUserBehavior(userId);
      riskScore += userRisk.score;
      riskFactors.push(...userRisk.factors);

      // 2. Transaction velocity checks (20 points max)
      const velocityRisk = await this.checkTransactionVelocity(userId, amount);
      riskScore += velocityRisk.score;
      riskFactors.push(...velocityRisk.factors);

      // 3. Amount-based risk assessment (15 points max)
      const amountRisk = this.assessAmountRisk(amount, currency);
      riskScore += amountRisk.score;
      riskFactors.push(...amountRisk.factors);

      // 4. Device and location analysis (20 points max)
      const deviceRisk = await this.analyzeDeviceAndLocation(userId, ipAddress, userAgent, deviceFingerprint);
      riskScore += deviceRisk.score;
      riskFactors.push(...deviceRisk.factors);

      // 5. Payment method risk (10 points max)
      const paymentRisk = this.assessPaymentMethodRisk(paymentMethod, provider);
      riskScore += paymentRisk.score;
      riskFactors.push(...paymentRisk.factors);

      // 6. Time-based risk assessment (10 points max)
      const timeRisk = this.assessTimeBasedRisk();
      riskScore += timeRisk.score;
      riskFactors.push(...timeRisk.factors);

      // Determine risk level
      let riskLevel: TempRiskLevel;
      if (riskScore >= this.CRITICAL_RISK_THRESHOLD) {
        riskLevel = TempRiskLevel.CRITICAL;
      } else if (riskScore >= this.HIGH_RISK_THRESHOLD) {
        riskLevel = TempRiskLevel.HIGH;
      } else if (riskScore >= 40) {
        riskLevel = TempRiskLevel.MEDIUM;
      } else {
        riskLevel = TempRiskLevel.LOW;
      }

      // Determine actions
      const autoBlock = riskLevel === TempRiskLevel.CRITICAL && riskScore >= 90;
      const requiresManualReview = riskLevel === TempRiskLevel.CRITICAL || (riskLevel === TempRiskLevel.HIGH && riskScore >= 80);
      const requiresAdditionalVerification = riskLevel === TempRiskLevel.HIGH || riskLevel === TempRiskLevel.MEDIUM;

      // Generate recommendations
      if (autoBlock) {
        recommendations.push('Transaction automatically blocked due to critical risk factors');
      }
      if (requiresManualReview) {
        recommendations.push('Manual review required before processing');
      }
      if (requiresAdditionalVerification) {
        recommendations.push('Additional verification recommended (SMS, ID check)');
      }
      if (riskScore > 30) {
        recommendations.push('Monitor transaction closely for any suspicious activity');
      }

      // Store risk assessment
      await this.storeRiskAssessment(userId, appointmentId, {
        riskScore,
        riskLevel,
        riskFactors,
        ipAddress,
        userAgent,
        deviceFingerprint
      });

      return {
        riskScore,
        riskLevel,
        riskFactors: riskFactors.filter(f => f), // Remove empty factors
        recommendations,
        autoBlock,
        requiresManualReview,
        requiresAdditionalVerification
      };

    } catch (error) {
      console.error('Risk assessment error:', error);
      // Default to high risk if assessment fails
      return {
        riskScore: 75,
        riskLevel: TempRiskLevel.HIGH,
        riskFactors: ['Risk assessment system error'],
        recommendations: ['Manual review required due to system error'],
        autoBlock: false,
        requiresManualReview: true,
        requiresAdditionalVerification: true
      };
    }
  }

  /**
   * Analyze user behavior patterns
   */
  private async analyzeUserBehavior(userId: string): Promise<{ score: number; factors: string[] }> {
    let score = 0;
    const factors: string[] = [];

    try {
      // Get user registration date
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          appointments: {
            where: { status: 'COMPLETED' }
          }
        }
      });

      if (!user) {
        score += 15;
        factors.push('User profile not found');
        return { score, factors };
      }

      const accountAge = Date.now() - user.createdAt.getTime();
      const daysSinceRegistration = accountAge / (1000 * 60 * 60 * 24);

      // New user risk (higher risk for very new accounts)
      if (daysSinceRegistration < 1) {
        score += 10;
        factors.push('Account created less than 24 hours ago');
      } else if (daysSinceRegistration < 7) {
        score += 5;
        factors.push('Account created less than 7 days ago');
      }

      // Profile completeness
      const profileComplete = user.firstName && user.lastName && user.email && user.phone;
      if (!profileComplete) {
        score += 8;
        factors.push('Incomplete user profile');
      }

      // Historical appointment behavior
      const completedAppointments = user.appointments?.length || 0;
      if (completedAppointments === 0) {
        score += 5;
        factors.push('No previous completed appointments');
      }

      // Check for previous payment issues
      const failedPayments = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          status: 'FAILED'
        }
      });

      if (failedPayments > 2) {
        score += 10;
        factors.push(`${failedPayments} previous failed payments`);
      } else if (failedPayments > 0) {
        score += 3;
        factors.push(`${failedPayments} previous failed payment(s)`);
      }

    } catch (error) {
      console.error('User behavior analysis error:', error);
      score += 10;
      factors.push('Unable to analyze user behavior');
    }

    return { score, factors };
  }

  /**
   * Check transaction velocity and patterns
   */
  private async checkTransactionVelocity(userId: string, amount: number): Promise<{ score: number; factors: string[] }> {
    let score = 0;
    const factors: string[] = [];

    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Check hourly velocity
      const hourlyTransactions = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          createdAt: { gte: oneHourAgo },
          status: { not: 'FAILED' }
        }
      });

      if (hourlyTransactions >= this.MAX_HOURLY_TRANSACTIONS) {
        score += 15;
        factors.push(`${hourlyTransactions} transactions in the last hour (max: ${this.MAX_HOURLY_TRANSACTIONS})`);
      } else if (hourlyTransactions >= 3) {
        score += 8;
        factors.push(`${hourlyTransactions} transactions in the last hour`);
      }

      // Check daily spending
      const dailySpending = await prisma.payment.aggregate({
        where: {
          appointment: { clientId: userId },
          createdAt: { gte: oneDayAgo },
          status: { in: ['AUTHORIZED', 'CAPTURED'] }
        },
        _sum: { totalAmount: true }
      });

      const dailyTotal = (dailySpending._sum.totalAmount || 0) + amount;
      if (dailyTotal > this.MAX_DAILY_AMOUNT) {
        score += 12;
        factors.push(`Daily spending exceeds limit: ${dailyTotal} AZN (max: ${this.MAX_DAILY_AMOUNT})`);
      } else if (dailyTotal > this.MAX_DAILY_AMOUNT * 0.7) {
        score += 5;
        factors.push(`High daily spending: ${dailyTotal} AZN`);
      }

      // Check for rapid consecutive transactions
      const recentTransactions = await prisma.payment.findMany({
        where: {
          appointment: { clientId: userId },
          createdAt: { gte: new Date(now.getTime() - 10 * 60 * 1000) } // Last 10 minutes
        },
        orderBy: { createdAt: 'desc' },
        take: 3
      });

      if (recentTransactions.length >= 2) {
        score += 8;
        factors.push(`${recentTransactions.length} transactions in the last 10 minutes`);
      }

    } catch (error) {
      console.error('Velocity check error:', error);
      score += 5;
      factors.push('Unable to check transaction velocity');
    }

    return { score, factors };
  }

  /**
   * Assess risk based on transaction amount
   */
  private assessAmountRisk(amount: number, currency: string): { score: number; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    // Convert to AZN for consistent evaluation
    let aznAmount = amount;
    if (currency === 'USD') aznAmount = amount * 1.70;
    else if (currency === 'EUR') aznAmount = amount * 1.85;

    // High amount risk
    if (aznAmount > this.MAX_TRANSACTION_AMOUNT) {
      score += 15;
      factors.push(`High transaction amount: ${aznAmount.toFixed(2)} AZN`);
    } else if (aznAmount > this.MAX_TRANSACTION_AMOUNT * 0.7) {
      score += 8;
      factors.push(`Above-average transaction amount: ${aznAmount.toFixed(2)} AZN`);
    }

    // Unusual round numbers (potential testing)
    if (aznAmount % 100 === 0 && aznAmount >= 500) {
      score += 3;
      factors.push('Round number amount (potential testing)');
    }

    return { score, factors };
  }

  /**
   * Analyze device and location patterns
   */
  private async analyzeDeviceAndLocation(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    deviceFingerprint?: string
  ): Promise<{ score: number; factors: string[] }> {
    let score = 0;
    const factors: string[] = [];

    try {
      if (!ipAddress && !userAgent) {
        score += 10;
        factors.push('Missing device/location information');
        return { score, factors };
      }

      // Check for new device/location
      const previousPayments = await prisma.payment.findMany({
        where: {
          appointment: { clientId: userId },
          status: { in: ['AUTHORIZED', 'CAPTURED'] }
        },
        take: 10,
        orderBy: { createdAt: 'desc' }
      });

      // Device consistency check
      if (userAgent && previousPayments.length > 0) {
        const knownDevices = previousPayments
          .map(p => p.userAgent)
          .filter(ua => ua)
          .filter((ua, index, arr) => arr.indexOf(ua) === index); // unique

        const isKnownDevice = knownDevices.includes(userAgent);
        if (!isKnownDevice && previousPayments.length >= 3) {
          score += 8;
          factors.push('New device detected');
        }
      }

      // IP address consistency
      if (ipAddress && previousPayments.length > 0) {
        const knownIPs = previousPayments
          .map(p => p.ipAddress)
          .filter(ip => ip)
          .filter((ip, index, arr) => arr.indexOf(ip) === index); // unique

        const isKnownIP = knownIPs.some(knownIP =>
          knownIP && this.isSameIPRange(ipAddress, knownIP)
        );

        if (!isKnownIP && previousPayments.length >= 2) {
          score += 6;
          factors.push('New IP address/location detected');
        }
      }

      // Check for suspicious IP patterns
      if (ipAddress) {
        const suspiciousIP = await this.checkSuspiciousIP(ipAddress);
        if (suspiciousIP.isSuspicious) {
          score += suspiciousIP.riskScore;
          factors.push(...suspiciousIP.reasons);
        }
      }

    } catch (error) {
      console.error('Device/location analysis error:', error);
      score += 5;
      factors.push('Unable to analyze device/location');
    }

    return { score, factors };
  }

  /**
   * Assess payment method risk
   */
  private assessPaymentMethodRisk(paymentMethod?: string, provider?: string): { score: number; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    // Provider risk assessment
    const lowRiskProviders = ['STRIPE', 'KAPITAL_BANK', 'PASHABANK'];
    const mediumRiskProviders = ['AZERBAIJAN_POSTAL_BANK', 'PAYPAL'];
    const highRiskProviders = ['LOCAL_TRANSFER'];

    if (provider && highRiskProviders.includes(provider)) {
      score += 8;
      factors.push(`High-risk payment provider: ${provider}`);
    } else if (provider && mediumRiskProviders.includes(provider)) {
      score += 3;
      factors.push(`Medium-risk payment provider: ${provider}`);
    }

    // Payment method risk
    if (paymentMethod === 'prepaid_card') {
      score += 5;
      factors.push('Prepaid card payment method');
    } else if (paymentMethod === 'bank_transfer') {
      score += 2;
      factors.push('Bank transfer payment method');
    }

    return { score, factors };
  }

  /**
   * Assess time-based risk factors
   */
  private assessTimeBasedRisk(): { score: number; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    // Late night transactions (higher risk)
    if (hour >= 23 || hour <= 5) {
      score += 5;
      factors.push(`Late night transaction (${hour}:00)`);
    }

    // Weekend transactions
    if (day === 0 || day === 6) {
      score += 2;
      factors.push('Weekend transaction');
    }

    return { score, factors };
  }

  /**
   * Check if IP is in suspicious ranges or known for fraud
   */
  private async checkSuspiciousIP(ipAddress: string): Promise<{ isSuspicious: boolean; riskScore: number; reasons: string[] }> {
    const reasons: string[] = [];
    let riskScore = 0;

    // Check for private/local IPs (suspicious for online payments)
    if (this.isPrivateIP(ipAddress)) {
      riskScore += 12;
      reasons.push('Private/local IP address detected');
    }

    // Check for known VPN/proxy ranges (simplified check)
    if (this.isKnownVPNRange(ipAddress)) {
      riskScore += 8;
      reasons.push('VPN/proxy IP detected');
    }

    // TODO: Integrate with IP reputation services
    // For now, check against a simple blacklist
    const isBlacklisted = await this.checkIPBlacklist(ipAddress);
    if (isBlacklisted) {
      riskScore += 15;
      reasons.push('IP address in blacklist');
    }

    return {
      isSuspicious: riskScore > 0,
      riskScore,
      reasons
    };
  }

  /**
   * Check if two IP addresses are in the same range (simplified)
   */
  private isSameIPRange(ip1: string, ip2: string): boolean {
    const parts1 = ip1.split('.');
    const parts2 = ip2.split('.');

    // Same if first 3 octets match (same /24 subnet)
    return parts1.slice(0, 3).join('.') === parts2.slice(0, 3).join('.');
  }

  /**
   * Check if IP is private/local
   */
  private isPrivateIP(ip: string): boolean {
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./
    ];

    return privateRanges.some(range => range.test(ip));
  }

  /**
   * Check if IP is from known VPN/proxy ranges
   */
  private isKnownVPNRange(ip: string): boolean {
    // Simplified VPN detection - in production, use specialized services
    const suspiciousRanges = [
      /^185\.220\./, // Tor exit nodes
      /^198\.98\./,  // Some VPN providers
      /^104\.244\./ // Common proxy ranges
    ];

    return suspiciousRanges.some(range => range.test(ip));
  }

  /**
   * Check IP against blacklist
   */
  private async checkIPBlacklist(ipAddress: string): Promise<boolean> {
    try {
      // Check against stored blacklist
      const blacklistedIP = await prisma.$queryRaw`
        SELECT 1 FROM ip_blacklist WHERE ip_address = ${ipAddress} LIMIT 1
      `;

      return Array.isArray(blacklistedIP) && blacklistedIP.length > 0;
    } catch (error) {
      // If blacklist table doesn't exist, return false
      return false;
    }
  }

  /**
   * Store risk assessment for audit and learning
   */
  private async storeRiskAssessment(
    userId: string,
    appointmentId: string,
    assessment: {
      riskScore: number;
      riskLevel: TempRiskLevel;
      riskFactors: string[];
      ipAddress?: string;
      userAgent?: string;
      deviceFingerprint?: string;
    }
  ): Promise<void> {
    try {
      // This would store in a risk assessment audit table
      console.log(`Risk Assessment for user ${userId}, appointment ${appointmentId}:`, {
        score: assessment.riskScore,
        level: assessment.riskLevel,
        factors: assessment.riskFactors.length,
        timestamp: new Date().toISOString()
      });

      // In a production system, you'd store this in a dedicated table
      // for fraud detection analytics and model training
    } catch (error) {
      console.error('Failed to store risk assessment:', error);
    }
  }

  /**
   * Flag user for manual review
   */
  async flagUserForReview(
    userId: string,
    reason: string,
    flaggedBy: string,
    metadata?: any
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Create manual review flag
      await prisma.user.update({
        where: { id: userId },
        data: {
          // Add flags to user record or create separate flagging system
          updatedAt: new Date()
        }
      });

      console.log(`User ${userId} flagged for manual review: ${reason}`, metadata);

      // TODO: Send notification to admin team
      // TODO: Add to review queue

      return { success: true };
    } catch (error) {
      console.error('Failed to flag user for review:', error);
      return { success: false, error: 'Failed to flag user for review' };
    }
  }

  /**
   * Block user temporarily or permanently
   */
  async blockUser(
    userId: string,
    duration: 'temporary' | 'permanent',
    reason: string,
    blockedBy: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const blockUntil = duration === 'temporary'
        ? new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        : null; // Permanent

      // Update user status
      await prisma.user.update({
        where: { id: userId },
        data: {
          // Add blocking fields to user model or create separate blocking system
          updatedAt: new Date()
        }
      });

      console.log(`User ${userId} blocked (${duration}): ${reason}`, { blockedBy, blockUntil });

      return { success: true };
    } catch (error) {
      console.error('Failed to block user:', error);
      return { success: false, error: 'Failed to block user' };
    }
  }

  /**
   * Generate fraud detection report
   */
  async generateFraudReport(startDate: Date, endDate: Date): Promise<any> {
    try {
      // Get risk assessments data
      const totalTransactions = await prisma.payment.count({
        where: {
          createdAt: { gte: startDate, lte: endDate }
        }
      });

      const highRiskTransactions = await prisma.payment.count({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          riskLevel: { in: ['HIGH', 'CRITICAL'] }
        }
      });

      const blockedTransactions = await prisma.payment.count({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          status: 'FAILED',
          riskLevel: 'CRITICAL'
        }
      });

      return {
        period: { startDate, endDate },
        statistics: {
          totalTransactions,
          highRiskTransactions,
          blockedTransactions,
          riskRate: totalTransactions > 0 ? (highRiskTransactions / totalTransactions * 100).toFixed(2) + '%' : '0%',
          blockRate: totalTransactions > 0 ? (blockedTransactions / totalTransactions * 100).toFixed(2) + '%' : '0%'
        },
        // Additional analytics would go here
      };
    } catch (error) {
      console.error('Failed to generate fraud report:', error);
      return null;
    }
  }
}

export default new FraudDetectionService();