import prisma from '../config/database';
import {
  User,
  VerificationDocument,
  VerificationDocumentType
} from '@prisma/client';

interface ComplianceCheck {
  checkId: string;
  type: 'AML' | 'KYC' | 'LICENSING' | 'TAX' | 'DATA_PROTECTION' | 'FINANCIAL';
  status: 'PASSED' | 'FAILED' | 'PENDING' | 'REQUIRES_REVIEW';
  details: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendations: string[];
  nextReviewDate?: Date;
}

interface KYCVerification {
  userId: string;
  documentType: 'ID_CARD' | 'PASSPORT' | 'DRIVERS_LICENSE' | 'UTILITY_BILL' | 'BANK_STATEMENT';
  documentNumber: string;
  issuedBy: string;
  expiryDate?: Date;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  verifiedBy?: string;
  verifiedAt?: Date;
  rejectionReason?: string;
}

interface AMLAlert {
  alertId: string;
  userId: string;
  alertType: 'SUSPICIOUS_TRANSACTION' | 'HIGH_RISK_JURISDICTION' | 'PEP_MATCH' | 'SANCTIONS_LIST' | 'UNUSUAL_PATTERN';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  triggeringData: any;
  status: 'OPEN' | 'INVESTIGATING' | 'CLOSED' | 'FALSE_POSITIVE';
  assignedTo?: string;
  resolution?: string;
}

interface LicenseValidation {
  lawyerId: string;
  licenseNumber: string;
  issuingAuthority: string;
  licenseType: string;
  issueDate: Date;
  expiryDate: Date;
  status: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED' | 'PENDING_RENEWAL';
  lastVerified: Date;
  nextVerificationDue: Date;
}

interface ComplianceReport {
  reportId: string;
  reportType: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'AUDIT';
  periodStart: Date;
  periodEnd: Date;
  overview: {
    totalUsers: number;
    verifiedUsers: number;
    complianceRate: number;
    outstandingIssues: number;
  };
  kycStatus: {
    verified: number;
    pending: number;
    rejected: number;
    expired: number;
  };
  amlAlerts: {
    total: number;
    open: number;
    resolved: number;
    falsePositives: number;
  };
  licenseStatus: {
    active: number;
    expired: number;
    expiringSoon: number;
    suspended: number;
  };
  recommendations: string[];
}

interface DataProtectionAudit {
  auditId: string;
  auditType: 'GDPR' | 'PERSONAL_DATA' | 'DATA_RETENTION' | 'DATA_BREACH';
  findings: Array<{
    category: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
    remediation: string;
    deadline: Date;
  }>;
  complianceScore: number;
  recommendations: string[];
}

class ComplianceService {
  private readonly PEP_LIST = ['known_pep_names']; // Would be loaded from external sources
  private readonly SANCTIONS_LIST = ['sanctions_entities']; // Would be loaded from OFAC, EU, etc.
  private readonly HIGH_RISK_JURISDICTIONS = ['Country_codes']; // High-risk countries
  private readonly LICENSE_RENEWAL_WARNING_DAYS = 30;
  private readonly KYC_REFRESH_INTERVAL_DAYS = 365; // Annual KYC refresh

  /**
   * Perform comprehensive compliance check for a user
   */
  async performComplianceCheck(userId: string): Promise<ComplianceCheck[]> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          lawyerProfile: true
        }
      });

      if (!user) {
        throw new Error('User not found');
      }

      const checks: ComplianceCheck[] = [];

      // Run all compliance checks in parallel
      const [
        kycCheck,
        amlCheck,
        licenseCheck,
        dataProtectionCheck,
        financialCheck
      ] = await Promise.all([
        this.performKYCCheck(user),
        this.performAMLCheck(user),
  user.lawyerProfile ? this.performLicenseCheck(user.lawyerProfile.id) : null,
        this.performDataProtectionCheck(user),
        this.performFinancialComplianceCheck(userId)
      ]);

      if (kycCheck) checks.push(kycCheck);
      if (amlCheck) checks.push(amlCheck);
      if (licenseCheck) checks.push(licenseCheck);
      if (dataProtectionCheck) checks.push(dataProtectionCheck);
      if (financialCheck) checks.push(financialCheck);

      // Store compliance check results
      await this.storeComplianceResults(userId, checks);

      return checks;

    } catch (error) {
      console.error('Perform compliance check error:', error);
      throw new Error('Failed to perform compliance check');
    }
  }

  /**
   * Perform KYC (Know Your Customer) verification
   */
  private async performKYCCheck(user: any): Promise<ComplianceCheck> {
    try {
      const recommendations: string[] = [];
      let status: 'PASSED' | 'FAILED' | 'PENDING' | 'REQUIRES_REVIEW' = 'FAILED';
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'HIGH';

      const verificationGaps: string[] = [];

      if (!user.isVerified) {
        verificationGaps.push('account verification');
      }
      if (!user.emailVerified) {
        verificationGaps.push('email verification');
      }
      if (!user.phoneVerified) {
        verificationGaps.push('phone verification');
      }

      const lawyerVerificationDocs = user.lawyerProfile
        ? await prisma.verificationDocument.findMany({
            where: { lawyerId: user.lawyerProfile.id }
          })
        : [];

      const verifiedLawyerDocs = lawyerVerificationDocs.filter(
        (doc: VerificationDocument) => doc.verificationStatus?.toUpperCase() === 'VERIFIED'
      );

      if (user.lawyerProfile) {
        const requiredLawyerDocs: VerificationDocumentType[] = [
          VerificationDocumentType.BAR_LICENSE
        ];

        const missingLawyerDocs = requiredLawyerDocs.filter(requiredType =>
          !verifiedLawyerDocs.some(
            doc =>
              doc.documentType === requiredType && (!doc.expirationDate || doc.expirationDate > new Date())
          )
        );

        if (missingLawyerDocs.length > 0) {
          verificationGaps.push(
            `verified ${missingLawyerDocs.map(doc => doc.replace('_', ' ').toLowerCase()).join(', ')}`
          );
        }
      }

      if (verificationGaps.length === 0) {
        status = 'PASSED';
        riskLevel = 'LOW';
      } else {
        status = user.isVerified ? 'REQUIRES_REVIEW' : 'FAILED';
        riskLevel = verificationGaps.length > 2 ? 'HIGH' : 'MEDIUM';
        recommendations.push('Complete outstanding verification steps');
      }

      const details =
        verificationGaps.length === 0
          ? 'All primary KYC checks satisfied'
          : `Missing verifications: ${verificationGaps.join(', ')}`;

      return {
        checkId: this.generateCheckId('KYC'),
        type: 'KYC',
        status,
        details,
        riskLevel,
        recommendations,
        nextReviewDate: this.calculateNextKYCReview()
      };

    } catch (error) {
      console.error('KYC check error:', error);
      return {
        checkId: this.generateCheckId('KYC'),
        type: 'KYC',
        status: 'FAILED',
        details: 'KYC verification system error',
        riskLevel: 'CRITICAL',
        recommendations: ['Contact support for manual KYC review']
      };
    }
  }

  /**
   * Perform AML (Anti-Money Laundering) screening
   */
  private async performAMLCheck(user: any): Promise<ComplianceCheck> {
    try {
      let status: 'PASSED' | 'FAILED' | 'PENDING' | 'REQUIRES_REVIEW' = 'PASSED';
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
      const recommendations: string[] = [];
      const alerts: string[] = [];

      // Check against PEP list
      const fullName = `${user.firstName} ${user.lastName}`.toLowerCase();
      const isPEP = this.PEP_LIST.some(pepName =>
        fullName.includes(pepName.toLowerCase())
      );

      if (isPEP) {
        alerts.push('Potential Politically Exposed Person (PEP) match');
        riskLevel = 'HIGH';
        status = 'REQUIRES_REVIEW';
        recommendations.push('Enhanced due diligence required for PEP');
      }

      // Check against sanctions lists
      const isSanctioned = this.SANCTIONS_LIST.some(sanctionedEntity =>
        fullName.includes(sanctionedEntity.toLowerCase())
      );

      if (isSanctioned) {
        alerts.push('Potential sanctions list match');
        riskLevel = 'CRITICAL';
        status = 'FAILED';
        recommendations.push('Immediate manual review required');
        recommendations.push('Suspend all transactions pending review');
      }

      // Check high-risk jurisdictions
      if (user.country && this.HIGH_RISK_JURISDICTIONS.includes(user.country)) {
        alerts.push(`User from high-risk jurisdiction: ${user.country}`);
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        recommendations.push('Enhanced monitoring for high-risk jurisdiction');
      }

      // Check transaction patterns
      const suspiciousPatterns = await this.checkSuspiciousPatterns(user.id);
      if (suspiciousPatterns.length > 0) {
        alerts.push(...suspiciousPatterns);
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        if (suspiciousPatterns.length > 2) {
          riskLevel = 'HIGH';
          status = 'REQUIRES_REVIEW';
        }
        recommendations.push('Monitor transaction patterns closely');
      }

      const details = alerts.length > 0
        ? `AML alerts: ${alerts.join('; ')}`
        : 'No AML red flags detected';

      return {
        checkId: this.generateCheckId('AML'),
        type: 'AML',
        status,
        details,
        riskLevel,
        recommendations
      };

    } catch (error) {
      console.error('AML check error:', error);
      return {
        checkId: this.generateCheckId('AML'),
        type: 'AML',
        status: 'FAILED',
        details: 'AML screening system error',
        riskLevel: 'CRITICAL',
        recommendations: ['Manual AML review required due to system error']
      };
    }
  }

  /**
   * Perform license validation for lawyers
   */
  private async performLicenseCheck(lawyerId: string): Promise<ComplianceCheck> {
    try {
      const lawyerProfile = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: {
          verificationDocuments: true
        }
      });

      const verificationDocuments = lawyerProfile?.verificationDocuments ?? [];

      if (!lawyerProfile || verificationDocuments.length === 0) {
        return {
          checkId: this.generateCheckId('LICENSE'),
          type: 'LICENSING',
          status: 'FAILED',
          details: 'No professional licenses found',
          riskLevel: 'CRITICAL',
          recommendations: ['Submit valid professional license documents']
        };
      }

      const now = new Date();
      const normalizedDocs = verificationDocuments.map(doc => ({
        ...doc,
        status: doc.verificationStatus?.toUpperCase() ?? 'PENDING'
      }));

      const licenseDocs = normalizedDocs.filter(
        doc => doc.documentType === VerificationDocumentType.BAR_LICENSE
      );

      const activeLicenses = licenseDocs.filter(
        doc => doc.status === 'VERIFIED' && (!doc.expirationDate || doc.expirationDate > now)
      );

      const expiredLicenses = licenseDocs.filter(
        doc => doc.expirationDate && doc.expirationDate <= now
      );

      const expiringSoon = licenseDocs.filter(
        doc =>
          doc.status === 'VERIFIED' &&
          doc.expirationDate &&
          doc.expirationDate > now &&
          doc.expirationDate <=
            new Date(now.getTime() + this.LICENSE_RENEWAL_WARNING_DAYS * 24 * 60 * 60 * 1000)
      );

      let status: 'PASSED' | 'FAILED' | 'PENDING' | 'REQUIRES_REVIEW' = 'PASSED';
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
      const recommendations: string[] = [];

      if (expiredLicenses.length > 0) {
        status = 'FAILED';
        riskLevel = 'CRITICAL';
        recommendations.push('Renew expired professional licenses immediately');
        recommendations.push('Suspend practice until licenses are renewed');
      } else if (expiringSoon.length > 0) {
        status = 'REQUIRES_REVIEW';
        riskLevel = 'MEDIUM';
        recommendations.push(`${expiringSoon.length} license(s) expiring within ${this.LICENSE_RENEWAL_WARNING_DAYS} days`);
        recommendations.push('Begin license renewal process');
      }

      const details = activeLicenses.length > 0
        ? `${activeLicenses.length} active license(s), ${expiredLicenses.length} expired, ${expiringSoon.length} expiring soon`
        : 'No active licenses found';

      return {
        checkId: this.generateCheckId('LICENSE'),
        type: 'LICENSING',
        status,
        details,
        riskLevel,
        recommendations,
        nextReviewDate:
          expiringSoon.length > 0
            ? expiringSoon[0].expirationDate ?? undefined
            : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000) // 90 days
      };

    } catch (error) {
      console.error('License check error:', error);
      return {
        checkId: this.generateCheckId('LICENSE'),
        type: 'LICENSING',
        status: 'FAILED',
        details: 'License validation system error',
        riskLevel: 'CRITICAL',
        recommendations: ['Manual license verification required']
      };
    }
  }

  /**
   * Perform data protection compliance check
   */
  private async performDataProtectionCheck(user: any): Promise<ComplianceCheck> {
    try {
      const recommendations: string[] = [];
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';

      // Check consent records
      const notificationPreferences = await prisma.notificationPreferences.findUnique({
        where: { userId: user.id }
      });

      if (!notificationPreferences) {
        riskLevel = 'MEDIUM';
        recommendations.push('Notification preferences not configured');
      }

      // Check data retention compliance
      const dataRetentionIssues = await this.checkDataRetention(user.id);
      if (dataRetentionIssues.length > 0) {
        riskLevel = 'HIGH';
        recommendations.push(...dataRetentionIssues);
      }

      const status = riskLevel === 'LOW' ? 'PASSED' : 'REQUIRES_REVIEW';
      const details = riskLevel === 'LOW'
        ? 'Data protection compliance verified'
        : `${recommendations.length} data protection issue(s) identified`;

      return {
        checkId: this.generateCheckId('DATA'),
        type: 'DATA_PROTECTION',
        status,
        details,
        riskLevel,
        recommendations
      };

    } catch (error) {
      console.error('Data protection check error:', error);
      return {
        checkId: this.generateCheckId('DATA'),
        type: 'DATA_PROTECTION',
        status: 'FAILED',
        details: 'Data protection compliance system error',
        riskLevel: 'CRITICAL',
        recommendations: ['Manual data protection review required']
      };
    }
  }

  /**
   * Perform financial compliance check
   */
  private async performFinancialComplianceCheck(userId: string): Promise<ComplianceCheck> {
    try {
      const recommendations: string[] = [];
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';

      // Check for large transactions that need reporting
      const largeTransactions = await prisma.payment.findMany({
        where: {
          appointment: { clientId: userId },
          totalAmount: { gte: 10000 }, // 10,000 AZN threshold
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
        }
      });

      if (largeTransactions.length > 0) {
        riskLevel = 'MEDIUM';
        recommendations.push(`${largeTransactions.length} large transaction(s) requiring reporting`);
      }

      // Check for tax compliance
      const taxIssues = await this.checkTaxCompliance(userId);
      if (taxIssues.length > 0) {
        riskLevel = 'HIGH';
        recommendations.push(...taxIssues);
      }

      // Check for unusual payment patterns
      const paymentAlerts = await this.checkPaymentPatterns(userId);
      if (paymentAlerts.length > 0) {
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        recommendations.push(...paymentAlerts);
      }

      const status = riskLevel === 'LOW' ? 'PASSED' : 'REQUIRES_REVIEW';
      const details = riskLevel === 'LOW'
        ? 'Financial compliance verified'
        : `${recommendations.length} financial compliance issue(s) identified`;

      return {
        checkId: this.generateCheckId('FINANCIAL'),
        type: 'FINANCIAL',
        status,
        details,
        riskLevel,
        recommendations
      };

    } catch (error) {
      console.error('Financial compliance check error:', error);
      return {
        checkId: this.generateCheckId('FINANCIAL'),
        type: 'FINANCIAL',
        status: 'FAILED',
        details: 'Financial compliance system error',
        riskLevel: 'CRITICAL',
        recommendations: ['Manual financial compliance review required']
      };
    }
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(
    reportType: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'AUDIT',
    periodStart: Date,
    periodEnd: Date
  ): Promise<ComplianceReport> {
    try {
      const reportId = this.generateReportId();

      // Calculate overview metrics
      const totalUsers = await prisma.user.count({
        where: { createdAt: { lte: periodEnd } }
      });

      const verifiedUsers = await prisma.user.count({
        where: {
          createdAt: { lte: periodEnd },
          isVerified: true
        }
      });

      const complianceRate = totalUsers > 0 ? (verifiedUsers / totalUsers) * 100 : 0;

      // Get KYC status
      const kycCounts = await this.getKYCStatusCounts(periodEnd);

      // Get AML alerts
      const amlCounts = await this.getAMLAlertCounts(periodStart, periodEnd);

      // Get license status
      const licenseCounts = await this.getLicenseStatusCounts(periodEnd);

      const outstandingIssues = amlCounts.open + licenseCounts.expired + kycCounts.pending;

      const recommendations = this.generateComplianceRecommendations(
        kycCounts,
        amlCounts,
        licenseCounts,
        complianceRate
      );

      const report: ComplianceReport = {
        reportId,
        reportType,
        periodStart,
        periodEnd,
        overview: {
          totalUsers,
          verifiedUsers,
          complianceRate,
          outstandingIssues
        },
        kycStatus: kycCounts,
        amlAlerts: amlCounts,
        licenseStatus: licenseCounts,
        recommendations
      };

      // Store report
      await this.storeComplianceReport(report);

      return report;

    } catch (error) {
      console.error('Generate compliance report error:', error);
      throw new Error('Failed to generate compliance report');
    }
  }

  /**
   * Helper methods
   */
  private async checkSuspiciousPatterns(userId: string): Promise<string[]> {
    const patterns: string[] = [];

    try {
      // Check for high-frequency transactions
      const recentTransactions = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      });

      if (recentTransactions > 10) {
        patterns.push('High transaction frequency detected');
      }

      // Check for round number transactions
      const roundAmountTransactions = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          totalAmount: { in: [1000, 2000, 5000, 10000] },
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      });

      if (roundAmountTransactions > 3) {
        patterns.push('Multiple round-amount transactions');
      }

    } catch (error) {
      console.error('Check suspicious patterns error:', error);
    }

    return patterns;
  }

  private async checkDataRetention(userId: string): Promise<string[]> {
    const issues: string[] = [];

    try {
      // Check for data older than retention period
      const oldData = await prisma.appointment.count({
        where: {
          clientId: userId,
          status: 'COMPLETED',
          consultationEndedAt: {
            lt: new Date(Date.now() - 7 * 365 * 24 * 60 * 60 * 1000) // 7 years
          }
        }
      });

      if (oldData > 0) {
        issues.push(`${oldData} records exceed data retention period`);
      }

    } catch (error) {
      console.error('Check data retention error:', error);
    }

    return issues;
  }

  private async checkTaxCompliance(userId: string): Promise<string[]> {
    const issues: string[] = [];

    // This would check for tax reporting requirements
    // Implementation depends on local tax laws

    return issues;
  }

  private async checkPaymentPatterns(userId: string): Promise<string[]> {
    const alerts: string[] = [];

    try {
      // Check for failed payment attempts
      const failedPayments = await prisma.payment.count({
        where: {
          appointment: { clientId: userId },
          status: 'FAILED',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      });

      if (failedPayments > 3) {
        alerts.push('Multiple failed payment attempts');
      }

    } catch (error) {
      console.error('Check payment patterns error:', error);
    }

    return alerts;
  }

  private async getKYCStatusCounts(endDate: Date): Promise<any> {
    // Implementation would aggregate KYC status counts
    return {
      verified: 0,
      pending: 0,
      rejected: 0,
      expired: 0
    };
  }

  private async getAMLAlertCounts(startDate: Date, endDate: Date): Promise<any> {
    // Implementation would aggregate AML alert counts
    return {
      total: 0,
      open: 0,
      resolved: 0,
      falsePositives: 0
    };
  }

  private async getLicenseStatusCounts(endDate: Date): Promise<any> {
    // Implementation would aggregate license status counts
    return {
      active: 0,
      expired: 0,
      expiringSoon: 0,
      suspended: 0
    };
  }

  private generateComplianceRecommendations(
    kycCounts: any,
    amlCounts: any,
    licenseCounts: any,
    complianceRate: number
  ): string[] {
    const recommendations: string[] = [];

    if (complianceRate < 80) {
      recommendations.push('Improve KYC verification rate - currently below 80%');
    }

    if (amlCounts.open > 0) {
      recommendations.push(`Address ${amlCounts.open} open AML alerts`);
    }

    if (licenseCounts.expired > 0) {
      recommendations.push(`Follow up on ${licenseCounts.expired} expired licenses`);
    }

    if (licenseCounts.expiringSoon > 0) {
      recommendations.push(`Send renewal reminders for ${licenseCounts.expiringSoon} expiring licenses`);
    }

    return recommendations;
  }

  private calculateNextKYCReview(): Date {
    return new Date(Date.now() + this.KYC_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  }

  private generateCheckId(type: string): string {
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.random().toString(36).substring(2, 4).toUpperCase();
    return `${type}-${timestamp}-${random}`;
  }

  private generateReportId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `COMP-${timestamp}-${random}`;
  }

  private async storeComplianceResults(userId: string, checks: ComplianceCheck[]): Promise<void> {
    try {
      console.log(`Compliance check results for user ${userId}:`, {
        totalChecks: checks.length,
        passed: checks.filter(c => c.status === 'PASSED').length,
        failed: checks.filter(c => c.status === 'FAILED').length,
        pending: checks.filter(c => c.status === 'PENDING').length,
        requiresReview: checks.filter(c => c.status === 'REQUIRES_REVIEW').length
      });
      // In production, store in compliance audit table
    } catch (error) {
      console.error('Store compliance results error:', error);
    }
  }

  private async storeComplianceReport(report: ComplianceReport): Promise<void> {
    try {
      console.log(`Compliance report ${report.reportId} generated:`, {
        type: report.reportType,
        period: `${report.periodStart.toISOString().split('T')[0]} to ${report.periodEnd.toISOString().split('T')[0]}`,
        complianceRate: `${report.overview.complianceRate.toFixed(2)}%`,
        outstandingIssues: report.overview.outstandingIssues
      });
      // In production, store in compliance reports table
    } catch (error) {
      console.error('Store compliance report error:', error);
    }
  }
}

export default new ComplianceService();