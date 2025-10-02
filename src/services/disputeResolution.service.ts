import prisma from '../config/database';
import { DisputeStatus, DisputeType, Prisma } from '@prisma/client';

type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';
type ResponseType = 'explanation' | 'counter_evidence' | 'settlement_offer' | 'acknowledgment';
type DisputePriority = 'normal' | 'high' | 'urgent';

enum TempDisputeType {
  PAYMENT_ISSUE = 'PAYMENT_ISSUE',
  SERVICE_QUALITY = 'SERVICE_QUALITY',
  NO_SHOW = 'NO_SHOW',
  BILLING_DISPUTE = 'BILLING_DISPUTE',
  REFUND_REQUEST = 'REFUND_REQUEST',
  TECHNICAL_ISSUE = 'TECHNICAL_ISSUE',
  OTHER = 'OTHER'
}

interface DisputeCreationParams {
  appointmentId: string;
  raisedBy: string;
  disputeType: TempDisputeType;
  category: string;
  description: string;
  evidence?: string[];
  requestedResolution: string;
  urgencyLevel?: UrgencyLevel;
}

interface DisputeResponse {
  disputeId: string;
  respondentId: string;
  responseType: ResponseType;
  response: string;
  evidence?: string[];
  settlementOffer?: number;
}

interface DisputeResolutionParams {
  disputeId: string;
  resolution: string;
  resolutionType: 'refund_full' | 'refund_partial' | 'no_refund' | 'compensation' | 'warning' | 'other';
  refundAmount?: number;
  compensationAmount?: number;
  penaltyToLawyer?: number;
  reasonCode: string;
  internalNotes?: string;
  status: string; // used as resolvedBy identifier for backward compatibility
}

interface DisputeEscalation {
  disputeId: string;
  escalatedBy: string;
  escalationType: 'senior_review' | 'legal_team' | 'external_arbitration';
  reason: string;
  status: 'normal' | 'high' | 'urgent';
}

interface DisputeMetrics {
  totalDisputes: number;
  openDisputes: number;
  resolvedDisputes: number;
  averageResolutionTime: number;
  disputesByType: Record<string, number>;
  resolutionOutcomes: Record<string, number>;
}

interface DisputeMessageEntry {
  id: string;
  actorId: string;
  role: 'initiator' | 'respondent' | 'admin';
  type: string;
  message: string;
  createdAt: string;
  evidence?: string[];
  settlementOffer?: number;
}

class DisputeResolutionService {
  private readonly AUTO_ESCALATION_DAYS = 7;

  /**
   * Create a new dispute
   */
  async createDispute(params: DisputeCreationParams): Promise<{ success: boolean; disputeId?: string; error?: string }> {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: params.appointmentId },
        include: { lawyer: true }
      });

      if (!appointment || !appointment.lawyer) {
        return { success: false, error: 'Appointment not found' };
      }

      const { raisedBy } = params;
      if (raisedBy !== appointment.clientId && raisedBy !== appointment.lawyer.userId) {
        return { success: false, error: 'User not authorized for this appointment' };
      }

      const respondentId = raisedBy === appointment.clientId ? appointment.lawyer.userId : appointment.clientId;
      const disputeReference = this.generateDisputeReference();
      const priority = this.mapUrgencyToPriority(params.urgencyLevel);

      const initialMessages: DisputeMessageEntry[] = [
        {
          id: this.generateMessageId(),
          actorId: raisedBy,
          role: 'initiator',
          type: 'dispute_created',
          message: params.description,
          createdAt: new Date().toISOString(),
          evidence: params.evidence?.length ? params.evidence : undefined
        }
      ];

      if (params.requestedResolution) {
        initialMessages.push({
          id: this.generateMessageId(),
          actorId: raisedBy,
          role: 'initiator',
          type: 'requested_resolution',
          message: params.requestedResolution,
          createdAt: new Date().toISOString()
        });
      }

      const dispute = await prisma.dispute.create({
        data: {
          appointmentId: params.appointmentId,
          disputeReference,
          type: this.mapDisputeType(params.disputeType),
          title: params.category || `Dispute ${disputeReference}`,
          description: params.description,
          amount: appointment.totalAmount,
          initiatedBy: raisedBy,
          respondent: respondentId,
          status: DisputeStatus.OPEN,
          priority,
          dueDate: new Date(Date.now() + this.AUTO_ESCALATION_DAYS * 24 * 60 * 60 * 1000),
          evidence: params.evidence?.length ? params.evidence : undefined,
          messages: this.serializeMessages(initialMessages)
        },
        select: { id: true }
      });

      return { success: true, disputeId: dispute.id };

    } catch (error) {
      console.error('Create dispute error:', error);
      return { success: false, error: 'Failed to create dispute' };
    }
  }

  /**
   * Add response to dispute
   */
  async addDisputeResponse(params: DisputeResponse): Promise<{ success: boolean; error?: string }> {
    try {
      const dispute = await prisma.dispute.findUnique({
        where: { id: params.disputeId },
        select: { initiatedBy: true, respondent: true, status: true, messages: true }
      });

      if (!dispute) {
        return { success: false, error: 'Dispute not found' };
      }

      if (params.respondentId !== dispute.initiatedBy && params.respondentId !== dispute.respondent) {
        return { success: false, error: 'User not authorized to respond to this dispute' };
      }

      const messages = this.parseMessages(dispute.messages);
      messages.push({
        id: this.generateMessageId(),
        actorId: params.respondentId,
        role: this.roleForActor(dispute.initiatedBy, dispute.respondent, params.respondentId),
        type: params.responseType,
        message: params.response,
        createdAt: new Date().toISOString(),
        evidence: params.evidence?.length ? params.evidence : undefined,
        settlementOffer: params.settlementOffer
      });

      const nextStatus =
        dispute.status === DisputeStatus.OPEN && params.respondentId !== dispute.initiatedBy
          ? DisputeStatus.INVESTIGATING
          : dispute.status;

      await prisma.dispute.update({
        where: { id: params.disputeId },
        data: {
          status: nextStatus,
          messages: this.serializeMessages(messages)
        }
      });

      return { success: true };

    } catch (error) {
      console.error('Add dispute response error:', error);
      return { success: false, error: 'Failed to add dispute response' };
    }
  }

  /**
   * Resolve dispute with admin decision
   */
  async resolveDispute(params: DisputeResolutionParams): Promise<{ success: boolean; error?: string }> {
    try {
      const dispute = await prisma.dispute.findUnique({
        where: { id: params.disputeId },
        select: { messages: true }
      });

      if (!dispute) {
        return { success: false, error: 'Dispute not found' };
      }

      const messages = this.parseMessages(dispute.messages);
      messages.push({
        id: this.generateMessageId(),
        actorId: params.status,
        role: 'admin',
        type: 'resolution',
        message: params.resolution,
        createdAt: new Date().toISOString()
      });

      await prisma.dispute.update({
        where: { id: params.disputeId },
        data: {
          status: DisputeStatus.RESOLVED,
          resolutionType: params.resolutionType,
          resolutionAmount: params.refundAmount ?? params.compensationAmount ?? 0,
          resolutionNotes: this.buildResolutionNotes(params),
          resolvedAt: new Date(),
          resolvedBy: params.status,
          messages: this.serializeMessages(messages)
        }
      });

      return { success: true };

    } catch (error) {
      console.error('Resolve dispute error:', error);
      return { success: false, error: 'Failed to resolve dispute' };
    }
  }

  /**
   * Escalate dispute to higher level
   */
  async escalateDispute(params: DisputeEscalation): Promise<{ success: boolean; error?: string }> {
    try {
      const dispute = await prisma.dispute.findUnique({
        where: { id: params.disputeId },
        select: { messages: true }
      });

      if (!dispute) {
        return { success: false, error: 'Dispute not found' };
      }

      const messages = this.parseMessages(dispute.messages);
      messages.push({
        id: this.generateMessageId(),
        actorId: params.escalatedBy,
        role: 'admin',
        type: 'escalation',
        message: `${params.escalationType}: ${params.reason}`,
        createdAt: new Date().toISOString()
      });

      await prisma.dispute.update({
        where: { id: params.disputeId },
        data: {
          status: DisputeStatus.ESCALATED,
          assignedAdmin: params.escalatedBy,
          priority: params.status,
          messages: this.serializeMessages(messages)
        }
      });

      return { success: true };

    } catch (error) {
      console.error('Escalate dispute error:', error);
      return { success: false, error: 'Failed to escalate dispute' };
    }
  }

  /**
   * Get dispute metrics and analytics
   */
  async getDisputeMetrics(): Promise<DisputeMetrics> {
    const [totalDisputes, openDisputes, resolvedDisputes] = await Promise.all([
      prisma.dispute.count(),
      prisma.dispute.count({ where: { status: DisputeStatus.OPEN } }),
      prisma.dispute.count({ where: { status: DisputeStatus.RESOLVED } })
    ]);

    const resolved = await prisma.dispute.findMany({
      where: { resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true }
    });

    const averageResolutionTime = resolved.length
      ? resolved.reduce((acc, item) => acc + (item.resolvedAt!.getTime() - item.createdAt.getTime()), 0) /
        resolved.length /
        (1000 * 60 * 60)
      : 0;

    const disputesByTypeQuery = await prisma.dispute.groupBy({
      by: ['type'],
      _count: { _all: true }
    });

    const resolutionOutcomeQuery = await prisma.dispute.groupBy({
      by: ['resolutionType'],
      _count: { _all: true },
      where: { resolutionType: { not: null } }
    });

    const disputesByType: Record<string, number> = {};
    disputesByTypeQuery.forEach(item => {
      disputesByType[item.type] = item._count._all;
    });

    const resolutionOutcomes: Record<string, number> = {};
    resolutionOutcomeQuery.forEach(item => {
      resolutionOutcomes[item.resolutionType ?? 'unspecified'] = item._count._all;
    });

    return {
      totalDisputes,
      openDisputes,
      resolvedDisputes,
      averageResolutionTime,
      disputesByType,
      resolutionOutcomes
    };
  }

  private mapDisputeType(type: TempDisputeType): DisputeType {
    switch (type) {
      case TempDisputeType.PAYMENT_ISSUE:
      case TempDisputeType.BILLING_DISPUTE:
        return DisputeType.BILLING_ERROR;
      case TempDisputeType.SERVICE_QUALITY:
        return DisputeType.POOR_QUALITY;
      case TempDisputeType.NO_SHOW:
        return DisputeType.NO_SHOW_CLIENT;
      case TempDisputeType.REFUND_REQUEST:
        return DisputeType.REFUND_REQUEST;
      case TempDisputeType.TECHNICAL_ISSUE:
        return DisputeType.TECHNICAL_ISSUES;
      case TempDisputeType.OTHER:
        return DisputeType.SERVICE_NOT_PROVIDED;
      default:
        return DisputeType.SERVICE_NOT_PROVIDED;
    }
  }

  private mapUrgencyToPriority(urgency?: UrgencyLevel): DisputePriority {
    switch (urgency) {
      case 'high':
        return 'high';
      case 'critical':
        return 'urgent';
      default:
        return 'normal';
    }
  }

  private roleForActor(initiatedBy: string, respondent: string, actorId: string): 'initiator' | 'respondent' | 'admin' {
    if (actorId === initiatedBy) {
      return 'initiator';
    }
    if (actorId === respondent) {
      return 'respondent';
    }
    return 'admin';
  }

  private generateDisputeReference(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `DISP-${timestamp}-${random}`;
  }

  private generateMessageId(): string {
    return `MSG-${Math.random().toString(36).substring(2, 10)}`;
  }

  private parseMessages(data: Prisma.JsonValue | null): DisputeMessageEntry[] {
    if (!data) {
      return [];
    }

    if (Array.isArray(data)) {
      return JSON.parse(JSON.stringify(data)) as DisputeMessageEntry[];
    }

    return [];
  }

  private serializeMessages(messages: DisputeMessageEntry[]): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(messages)) as Prisma.InputJsonValue;
  }

  private buildResolutionNotes(params: DisputeResolutionParams): string {
    const segments: string[] = [`Resolution: ${params.resolution}`];

    if (params.reasonCode) {
      segments.push(`Reason code: ${params.reasonCode}`);
    }

    if (params.internalNotes) {
      segments.push(`Notes: ${params.internalNotes}`);
    }

    if (params.penaltyToLawyer) {
      segments.push(`Penalty to lawyer: ${params.penaltyToLawyer}`);
    }

    if (params.compensationAmount) {
      segments.push(`Compensation: ${params.compensationAmount}`);
    }

    if (params.refundAmount) {
      segments.push(`Refund: ${params.refundAmount}`);
    }

    return segments.join(' | ');
  }
}

export default new DisputeResolutionService();