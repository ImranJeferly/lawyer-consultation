import { PrismaClient, Document, DocumentFolder, SecurityLevel, DocumentCategory } from '@prisma/client';
import cron from 'node-cron';
import prisma from '../config/database';
import firebaseService from './firebase.service';

interface RetentionPolicy {
  id: string;
  name: string;
  description: string;
  category: DocumentCategory | 'ALL';
  securityLevel: SecurityLevel | 'ALL';
  retentionPeriod: {
    years: number;
    months: number;
    days: number;
  };
  actions: {
    warnBeforeExpiry: boolean;
    warningDays: number[];
    autoDelete: boolean;
    requireApproval: boolean;
    moveToArchive: boolean;
  };
  legalBasis: string;
  jurisdiction: string[];
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface LegalHold {
  id: string;
  name: string;
  description: string;
  reason: 'litigation' | 'investigation' | 'audit' | 'regulatory' | 'other';
  requestedBy: string;
  approvedBy?: string;
  startDate: Date;
  expectedEndDate?: Date;
  actualEndDate?: Date;
  status: 'active' | 'released' | 'expired';
  documents: string[]; // Document IDs
  folders: string[]; // Folder IDs
  searchCriteria?: {
    keywords: string[];
    dateRange: { from: Date; to: Date };
    categories: DocumentCategory[];
    authors: string[];
  };
  notifications: {
    recipients: string[];
    frequency: 'immediate' | 'daily' | 'weekly';
    lastSent?: Date;
  };
  auditTrail: Array<{
    timestamp: Date;
    action: string;
    userId: string;
    details: any;
  }>;
}

interface ComplianceReport {
  documentId: string;
  fileName: string;
  category: DocumentCategory;
  securityLevel: SecurityLevel;
  createdAt: Date;
  lastAccessedAt?: Date;
  retentionPolicy?: RetentionPolicy;
  retentionStatus: 'active' | 'warning' | 'expired' | 'on_hold' | 'archived';
  daysUntilExpiry?: number;
  legalHolds: string[]; // Legal hold IDs
  complianceFlags: Array<{
    type: 'retention_expired' | 'access_violation' | 'security_breach' | 'audit_required';
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    detectedAt: Date;
    resolvedAt?: Date;
  }>;
  recommendations: string[];
}

interface AuditLog {
  id: string;
  documentId: string;
  userId: string;
  action: 'view' | 'download' | 'edit' | 'share' | 'delete' | 'restore' | 'export';
  timestamp: Date;
  ipAddress: string;
  userAgent: string;
  details: any;
  complianceRelevant: boolean;
}

interface PrivilegeProtection {
  documentId: string;
  privilegeType: 'attorney_client' | 'work_product' | 'confidential' | 'privileged_communication';
  claimantId: string; // Lawyer/firm asserting privilege
  basis: string;
  protectionLevel: 'full' | 'partial' | 'waived';
  expirationDate?: Date;
  waiverConditions?: string[];
  accessLog: Array<{
    userId: string;
    accessTime: Date;
    justification: string;
    approvedBy?: string;
  }>;
}

class LegalComplianceService {
  private retentionPolicies = new Map<string, RetentionPolicy>();
  private legalHolds = new Map<string, LegalHold>();

  constructor() {
    // Initialize compliance monitoring
    this.initializeComplianceMonitoring();
  }

  /**
   * Create retention policy
   */
  async createRetentionPolicy(policyData: Omit<RetentionPolicy, 'id' | 'createdAt' | 'updatedAt'>): Promise<RetentionPolicy | null> {
    try {
      const policy: RetentionPolicy = {
        id: crypto.randomUUID(),
        ...policyData,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      this.retentionPolicies.set(policy.id, policy);

      // Apply policy to existing documents
      await this.applyRetentionPolicyToExistingDocuments(policy);

      // Log policy creation
      await this.logComplianceAction('RETENTION_POLICY_CREATED', policyData.createdBy, {
        policyId: policy.id,
        policyName: policy.name
      });

      return policy;

    } catch (error) {
      console.error('Failed to create retention policy:', error);
      return null;
    }
  }

  /**
   * Create legal hold
   */
  async createLegalHold(holdData: Omit<LegalHold, 'id' | 'auditTrail'>): Promise<LegalHold | null> {
    try {
      const legalHold: LegalHold = {
        id: crypto.randomUUID(),
        ...holdData,
        auditTrail: [
          {
            timestamp: new Date(),
            action: 'LEGAL_HOLD_CREATED',
            userId: holdData.requestedBy,
            details: {
              name: holdData.name,
              reason: holdData.reason
            }
          }
        ]
      };

      this.legalHolds.set(legalHold.id, legalHold);

      // Apply hold to documents and folders
      await this.applyLegalHold(legalHold);

      // Notify relevant parties
      await this.sendLegalHoldNotifications(legalHold);

      return legalHold;

    } catch (error) {
      console.error('Failed to create legal hold:', error);
      return null;
    }
  }

  /**
   * Generate compliance report for document
   */
  async generateComplianceReport(documentId: string, userId: string): Promise<ComplianceReport | null> {
    try {
      // Verify access to document
      const document = await this.getDocumentWithAccess(documentId, userId);
      if (!document) {
        throw new Error('Document not found or no access');
      }

      // Find applicable retention policy
      const retentionPolicy = await this.findApplicableRetentionPolicy(document);

      // Calculate retention status
      const retentionStatus = await this.calculateRetentionStatus(document, retentionPolicy);

      // Find applicable legal holds
      const legalHolds = await this.findApplicableLegalHolds(document);

      // Detect compliance flags
      const complianceFlags = await this.detectComplianceFlags(document, retentionPolicy);

      // Generate recommendations
      const recommendations = await this.generateComplianceRecommendations(document, retentionStatus.status, complianceFlags);

      const report: ComplianceReport = {
        documentId: document.id,
        fileName: document.fileName,
        category: document.category,
        securityLevel: document.securityLevel,
        createdAt: document.createdAt,
        lastAccessedAt: document.lastAccessedAt,
        retentionPolicy: retentionPolicy || undefined,
        retentionStatus: retentionStatus.status,
        daysUntilExpiry: retentionStatus.daysUntilExpiry,
        legalHolds: legalHolds.map(hold => hold.id),
        complianceFlags,
        recommendations
      };

      return report;

    } catch (error) {
      console.error('Failed to generate compliance report:', error);
      return null;
    }
  }

  /**
   * Set up privilege protection
   */
  async setPrivilegeProtection(privilegeData: PrivilegeProtection): Promise<boolean> {
    try {
      // Verify the claimant has authority to assert privilege
      const canAssertPrivilege = await this.verifyPrivilegeAuthority(
        privilegeData.claimantId,
        privilegeData.documentId
      );

      if (!canAssertPrivilege) {
        throw new Error('Insufficient authority to assert privilege');
      }

      // Update document with privilege protection
      await prisma.document.update({
        where: { id: privilegeData.documentId },
        data: {
          isPrivileged: true
        }
      });

      // Log privilege assertion
      await this.logComplianceAction('PRIVILEGE_ASSERTED', privilegeData.claimantId, {
        documentId: privilegeData.documentId,
        privilegeType: privilegeData.privilegeType,
        basis: privilegeData.basis
      });

      return true;

    } catch (error) {
      console.error('Failed to set privilege protection:', error);
      return false;
    }
  }

  /**
   * Perform compliance audit
   */
  async performComplianceAudit(
    scope: {
      documentIds?: string[];
      folderIds?: string[];
      categories?: DocumentCategory[];
      dateRange?: { from: Date; to: Date };
    },
    auditType: 'retention' | 'access' | 'security' | 'comprehensive',
    requestedBy: string
  ): Promise<{
    auditId: string;
    findings: Array<{
      documentId: string;
      issueType: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      description: string;
      recommendation: string;
    }>;
    summary: {
      totalDocuments: number;
      compliantDocuments: number;
      issuesFound: number;
      criticalIssues: number;
    };
  }> {
    try {
      const auditId = crypto.randomUUID();

      // Get documents in scope
      const documents = await this.getDocumentsInScope(scope);

      const findings: any[] = [];
      let compliantDocuments = 0;
      let criticalIssues = 0;

      for (const document of documents) {
        const docFindings = await this.auditDocument(document, auditType);
        findings.push(...docFindings);

        const hasCritical = docFindings.some(f => f.severity === 'critical');
        if (hasCritical) {
          criticalIssues++;
        } else if (docFindings.length === 0) {
          compliantDocuments++;
        }
      }

      // Log audit
      await this.logComplianceAction('COMPLIANCE_AUDIT_PERFORMED', requestedBy, {
        auditId,
        auditType,
        scope,
        totalDocuments: documents.length,
        issuesFound: findings.length
      });

      return {
        auditId,
        findings,
        summary: {
          totalDocuments: documents.length,
          compliantDocuments,
          issuesFound: findings.length,
          criticalIssues
        }
      };

    } catch (error) {
      console.error('Failed to perform compliance audit:', error);
      throw error;
    }
  }

  /**
   * Release legal hold
   */
  async releaseLegalHold(holdId: string, releasedBy: string, reason: string): Promise<boolean> {
    try {
      const legalHold = this.legalHolds.get(holdId);
      if (!legalHold) {
        throw new Error('Legal hold not found');
      }

      if (legalHold.status !== 'active') {
        throw new Error('Legal hold is not active');
      }

      // Update hold status
      legalHold.status = 'released';
      legalHold.actualEndDate = new Date();
      legalHold.auditTrail.push({
        timestamp: new Date(),
        action: 'LEGAL_HOLD_RELEASED',
        userId: releasedBy,
        details: { reason }
      });

      // Remove hold from documents
      await this.removeLegalHoldFromDocuments(legalHold);

      // Send notifications
      await this.sendLegalHoldReleaseNotifications(legalHold, reason);

      return true;

    } catch (error) {
      console.error('Failed to release legal hold:', error);
      return false;
    }
  }

  /**
   * Initialize compliance monitoring
   */
  private initializeComplianceMonitoring(): void {
    // Run daily at midnight
    cron.schedule('0 0 * * *', async () => {
      await this.performDailyComplianceCheck();
    });

    // Run weekly compliance report
    cron.schedule('0 0 * * 0', async () => {
      await this.generateWeeklyComplianceReport();
    });

    // Run monthly retention policy enforcement
    cron.schedule('0 0 1 * *', async () => {
      await this.enforceRetentionPolicies();
    });
  }

  /**
   * Daily compliance check
   */
  private async performDailyComplianceCheck(): Promise<void> {
    try {
      console.log('Starting daily compliance check...');

      // Check for documents approaching retention expiry
      await this.checkRetentionExpiryWarnings();

      // Check for expired legal holds
      await this.checkExpiredLegalHolds();

      // Check for unauthorized access attempts
      await this.checkUnauthorizedAccess();

      // Update compliance metrics
      await this.updateComplianceMetrics();

      console.log('Daily compliance check completed');

    } catch (error) {
      console.error('Daily compliance check failed:', error);
    }
  }

  /**
   * Check retention expiry warnings
   */
  private async checkRetentionExpiryWarnings(): Promise<void> {
    try {
      const documents = await prisma.document.findMany({
        where: {
          workflowStatus: { not: 'DRAFT' },
          isUnderLegalHold: { not: true }
        },
        include: {
          owner: {
            select: { id: true, firstName: true, lastName: true, email: true }
          }
        }
      });

      for (const document of documents) {
        const retentionPolicy = await this.findApplicableRetentionPolicy(document);
        if (!retentionPolicy) continue;

        const retentionStatus = await this.calculateRetentionStatus(document, retentionPolicy);

        if (retentionStatus.daysUntilExpiry !== undefined) {
          const warningDays = retentionPolicy.actions.warningDays || [30, 7, 1];

          if (warningDays.includes(retentionStatus.daysUntilExpiry)) {
            await this.sendRetentionExpiryWarning(document, retentionPolicy, retentionStatus.daysUntilExpiry);
          }

          if (retentionStatus.daysUntilExpiry <= 0 && retentionPolicy.actions.autoDelete) {
            await this.processRetentionExpiry(document, retentionPolicy);
          }
        }
      }

    } catch (error) {
      console.error('Failed to check retention expiry warnings:', error);
    }
  }

  /**
   * Calculate retention status
   */
  private async calculateRetentionStatus(
    document: any,
    policy: RetentionPolicy | null
  ): Promise<{
    status: ComplianceReport['retentionStatus'];
    daysUntilExpiry?: number;
  }> {
    if (!policy) {
      return { status: 'active' };
    }

    // Check if document is on legal hold
    const isOnLegalHold = await this.isDocumentOnLegalHold(document.id);
    if (isOnLegalHold) {
      return { status: 'on_hold' };
    }

    // Calculate expiry date
    const retentionDate = new Date(document.createdAt);
    retentionDate.setFullYear(retentionDate.getFullYear() + policy.retentionPeriod.years);
    retentionDate.setMonth(retentionDate.getMonth() + policy.retentionPeriod.months);
    retentionDate.setDate(retentionDate.getDate() + policy.retentionPeriod.days);

    const now = new Date();
    const daysUntilExpiry = Math.ceil((retentionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
      return { status: 'expired', daysUntilExpiry: 0 };
    } else if (daysUntilExpiry <= 30) {
      return { status: 'warning', daysUntilExpiry };
    } else {
      return { status: 'active', daysUntilExpiry };
    }
  }

  /**
   * Find applicable retention policy
   */
  private async findApplicableRetentionPolicy(document: any): Promise<RetentionPolicy | null> {
    for (const [, policy] of this.retentionPolicies) {
      if (!policy.isActive) continue;

      // Check category match
      if (policy.category !== 'ALL' && policy.category !== document.category) {
        continue;
      }

      // Check security level match
      if (policy.securityLevel !== 'ALL' && policy.securityLevel !== document.securityLevel) {
        continue;
      }

      return policy;
    }

    return null;
  }

  /**
   * Apply retention policy to existing documents
   */
  private async applyRetentionPolicyToExistingDocuments(policy: RetentionPolicy): Promise<void> {
    try {
      const whereClause: any = {
        workflowStatus: { not: 'DRAFT' }
      };

      if (policy.category !== 'ALL') {
        whereClause.category = policy.category;
      }

      if (policy.securityLevel !== 'ALL') {
        whereClause.securityLevel = policy.securityLevel;
      }

      const documents = await prisma.document.findMany({
        where: whereClause,
        select: { id: true }
      });

      console.log(`Applying retention policy "${policy.name}" to ${documents.length} documents`);

      // Update documents with policy reference
      for (const document of documents) {
        await prisma.document.update({
          where: { id: document.id },
          data: {

            updatedAt: new Date()
          }
        });
      }

    } catch (error) {
      console.error('Failed to apply retention policy to existing documents:', error);
    }
  }

  /**
   * Helper methods
   */
  private async getDocumentWithAccess(documentId: string, userId: string): Promise<any | null> {
    return prisma.document.findFirst({
      where: {
        id: documentId,
        OR: [
          { ownerId: userId },
          {
            shares: {
              some: {


              }
            }
          }
        ],
        workflowStatus: { not: 'DRAFT' }
      }
    });
  }

  private async findApplicableLegalHolds(document: any): Promise<LegalHold[]> {
    const applicableHolds: LegalHold[] = [];

    for (const [, hold] of this.legalHolds) {
      if (hold.status !== 'active') continue;

      // Check if document is explicitly included
      if (hold.documents.includes(document.id)) {
        applicableHolds.push(hold);
        continue;
      }

      // Check if document matches search criteria
      if (hold.searchCriteria && this.matchesSearchCriteria(document, hold.searchCriteria)) {
        applicableHolds.push(hold);
      }
    }

    return applicableHolds;
  }

  private matchesSearchCriteria(document: any, criteria: LegalHold['searchCriteria']): boolean {
    if (!criteria) return false;

    // Check keywords
    if (criteria.keywords && criteria.keywords.length > 0) {
      const content = `${document.fileName} ${document.description || ''} ${document.extractedText || ''}`.toLowerCase();
      const hasKeyword = criteria.keywords.some(keyword =>
        content.includes(keyword.toLowerCase())
      );
      if (!hasKeyword) return false;
    }

    // Check date range
    if (criteria.dateRange) {
      const docDate = new Date(document.createdAt);
      if (docDate < criteria.dateRange.from || docDate > criteria.dateRange.to) {
        return false;
      }
    }

    // Check categories
    if (criteria.categories && criteria.categories.length > 0) {
      if (!criteria.categories.includes(document.category)) {
        return false;
      }
    }

    // Check authors
    if (criteria.authors && criteria.authors.length > 0) {
      if (!criteria.authors.includes(document.ownerId)) {
        return false;
      }
    }

    return true;
  }

  private async detectComplianceFlags(document: any, policy: RetentionPolicy | null): Promise<ComplianceReport['complianceFlags']> {
    const flags: ComplianceReport['complianceFlags'] = [];

    // Check retention expiry
    if (policy) {
      const retentionStatus = await this.calculateRetentionStatus(document, policy);
      if (retentionStatus.status === 'expired') {
        flags.push({
          type: 'retention_expired',
          severity: 'high',
          description: 'Document has exceeded its retention period',
          detectedAt: new Date()
        });
      }
    }

    // Check for unusual access patterns
    const accessLogs = await this.getRecentAccessLogs(document.id);
    if (this.detectUnusualAccessPattern(accessLogs)) {
      flags.push({
        type: 'access_violation',
        severity: 'medium',
        description: 'Unusual access pattern detected',
        detectedAt: new Date()
      });
    }

    return flags;
  }

  private async generateComplianceRecommendations(
    document: any,
    retentionStatus: string,
    flags: ComplianceReport['complianceFlags']
  ): Promise<string[]> {
    const recommendations: string[] = [];

    if (retentionStatus === 'expired') {
      recommendations.push('Document has exceeded retention period. Consider archiving or deletion per policy.');
    }

    if (retentionStatus === 'warning') {
      recommendations.push('Document will expire soon. Review for continued business need.');
    }

    if (flags.some(f => f.type === 'access_violation')) {
      recommendations.push('Review access permissions and audit recent activity.');
    }

    if (document.securityLevel === 'PUBLIC' && document.category === 'CONTRACT') {
      recommendations.push('Consider upgrading security level for contract documents.');
    }

    return recommendations;
  }

  private async isDocumentOnLegalHold(documentId: string): Promise<boolean> {
    for (const [, hold] of this.legalHolds) {
      if (hold.status === 'active' && hold.documents.includes(documentId)) {
        return true;
      }
    }
    return false;
  }

  private async applyLegalHold(legalHold: LegalHold): Promise<void> {
    // Update documents to mark them as on legal hold
    const documentIds = legalHold.documents;

    if (documentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: documentIds } },
        data: {
          isUnderLegalHold: true
        }
      });
    }

    // Apply to folders
    for (const folderId of legalHold.folders) {
      await this.applyLegalHoldToFolder(folderId, legalHold.id);
    }
  }

  private async applyLegalHoldToFolder(folderId: string, holdId: string): Promise<void> {
    // Get all documents in folder and subfolders
    const documents = await prisma.document.findMany({
      where: {
        OR: [
          { folderId },
          {
            folder: {
              path: { startsWith: folderId }
            }
          }
        ]
      }
    });

    // Apply hold to all documents
    const documentIds = documents.map(doc => doc.id);
    if (documentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: documentIds } },
        data: {
          isUnderLegalHold: true
        }
      });
    }
  }

  private async logComplianceAction(action: string, userId: string, details: any): Promise<void> {
    console.log('Compliance Action:', {
      action,
      userId,
      details,
      timestamp: new Date()
    });
  }

  private async sendLegalHoldNotifications(legalHold: LegalHold): Promise<void> {
    // Implementation for sending notifications
  }

  private async sendLegalHoldReleaseNotifications(legalHold: LegalHold, reason: string): Promise<void> {
    // Implementation for sending release notifications
  }

  private async removeLegalHoldFromDocuments(legalHold: LegalHold): Promise<void> {
    // Implementation for removing legal hold from documents
  }

  private async getDocumentsInScope(scope: any): Promise<any[]> {
    // Implementation for getting documents in audit scope
    return [];
  }

  private async auditDocument(document: any, auditType: string): Promise<any[]> {
    // Implementation for auditing individual document
    return [];
  }

  private async checkExpiredLegalHolds(): Promise<void> {
    // Implementation for checking expired legal holds
  }

  private async checkUnauthorizedAccess(): Promise<void> {
    // Implementation for checking unauthorized access
  }

  private async updateComplianceMetrics(): Promise<void> {
    // Implementation for updating compliance metrics
  }

  private async generateWeeklyComplianceReport(): Promise<void> {
    // Implementation for generating weekly compliance report
  }

  private async enforceRetentionPolicies(): Promise<void> {
    // Implementation for enforcing retention policies
  }

  private async sendRetentionExpiryWarning(document: any, policy: RetentionPolicy, days: number): Promise<void> {
    // Implementation for sending retention expiry warnings
  }

  private async processRetentionExpiry(document: any, policy: RetentionPolicy): Promise<void> {
    // Implementation for processing retention expiry
  }

  private async verifyPrivilegeAuthority(claimantId: string, documentId: string): Promise<boolean> {
    // Implementation for verifying privilege authority
    return true;
  }

  private async getRecentAccessLogs(documentId: string): Promise<AuditLog[]> {
    // Implementation for getting recent access logs
    return [];
  }

  private detectUnusualAccessPattern(logs: AuditLog[]): boolean {
    // Implementation for detecting unusual access patterns
    return false;
  }
}

export default new LegalComplianceService();
export {
  LegalComplianceService,
  RetentionPolicy,
  LegalHold,
  ComplianceReport,
  AuditLog,
  PrivilegeProtection
};