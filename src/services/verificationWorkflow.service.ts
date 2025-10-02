import { LawyerProfile, VerificationStatus, PrismaClient } from '@prisma/client';
import prisma from '../config/database';

interface VerificationTransition {
  from: VerificationStatus;
  to: VerificationStatus;
  requiredFields?: string[];
  action?: string;
}

interface VerificationWorkflowResult {
  success: boolean;
  newStatus?: VerificationStatus;
  message: string;
  requiredActions?: string[];
  error?: string;
}

class VerificationWorkflowService {
  private readonly validTransitions: VerificationTransition[] = [
    {
      from: VerificationStatus.PENDING,
      to: VerificationStatus.DOCUMENTS_REQUIRED,
      action: 'request_documents'
    },
    {
      from: VerificationStatus.DOCUMENTS_REQUIRED,
      to: VerificationStatus.UNDER_REVIEW,
      requiredFields: ['verificationDocuments'],
      action: 'submit_documents'
    },
    {
      from: VerificationStatus.UNDER_REVIEW,
      to: VerificationStatus.VERIFIED,
      action: 'approve'
    },
    {
      from: VerificationStatus.UNDER_REVIEW,
      to: VerificationStatus.REJECTED,
      action: 'reject'
    },
    {
      from: VerificationStatus.REJECTED,
      to: VerificationStatus.DOCUMENTS_REQUIRED,
      action: 'resubmit'
    },
    {
      from: VerificationStatus.VERIFIED,
      to: VerificationStatus.SUSPENDED,
      action: 'suspend'
    },
    {
      from: VerificationStatus.SUSPENDED,
      to: VerificationStatus.UNDER_REVIEW,
      action: 'reinstate'
    }
  ];

  /**
   * Check if a status transition is valid
   */
  isValidTransition(currentStatus: VerificationStatus, newStatus: VerificationStatus): boolean {
    return this.validTransitions.some(
      transition => transition.from === currentStatus && transition.to === newStatus
    );
  }

  /**
   * Get available transitions for a current status
   */
  getAvailableTransitions(currentStatus: VerificationStatus): VerificationTransition[] {
    return this.validTransitions.filter(transition => transition.from === currentStatus);
  }

  /**
   * Transition lawyer verification status
   */
  async transitionStatus(
    lawyerId: string,
    newStatus: VerificationStatus,
    adminId?: string,
    notes?: string
  ): Promise<VerificationWorkflowResult> {
    try {
      const lawyerProfile = await prisma.lawyerProfile.findUnique({
        where: { id: lawyerId },
        include: { verificationDocuments: true }
      });

      if (!lawyerProfile) {
        return {
          success: false,
          message: 'Lawyer profile not found',
          error: 'LAWYER_NOT_FOUND'
        };
      }

      const currentStatus = lawyerProfile.verificationStatus;

      // Check if transition is valid
      if (!this.isValidTransition(currentStatus, newStatus)) {
        return {
          success: false,
          message: `Invalid transition from ${currentStatus} to ${newStatus}`,
          error: 'INVALID_TRANSITION'
        };
      }

      // Check required fields for transition
      const transition = this.validTransitions.find(
        t => t.from === currentStatus && t.to === newStatus
      );

      if (transition?.requiredFields) {
        const missingFields = this.checkRequiredFields(lawyerProfile, transition.requiredFields);
        if (missingFields.length > 0) {
          return {
            success: false,
            message: 'Missing required fields for transition',
            requiredActions: missingFields,
            error: 'MISSING_REQUIREMENTS'
          };
        }
      }

      // Perform the transition
      const updatedProfile = await this.executeTransition(
        lawyerId,
        newStatus,
        adminId,
        notes
      );

      return {
        success: true,
        newStatus: updatedProfile.verificationStatus,
        message: `Status successfully updated to ${newStatus}`
      };

    } catch (error) {
      console.error('Verification workflow error:', error);
      return {
        success: false,
        message: 'Failed to update verification status',
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
      };
    }
  }

  /**
   * Execute the status transition
   */
  private async executeTransition(
    lawyerId: string,
    newStatus: VerificationStatus,
    adminId?: string,
    notes?: string
  ): Promise<LawyerProfile> {
    const updateData: any = {
      verificationStatus: newStatus,
      verificationNotes: notes
    };

    // Set timestamps based on status
    switch (newStatus) {
      case VerificationStatus.DOCUMENTS_REQUIRED:
        if (!updateData.verificationSubmittedAt) {
          updateData.verificationSubmittedAt = new Date();
        }
        break;

      case VerificationStatus.VERIFIED:
        updateData.verificationCompletedAt = new Date();
        updateData.isVerified = true;
        break;

      case VerificationStatus.REJECTED:
        updateData.verificationCompletedAt = new Date();
        updateData.isVerified = false;
        break;

      case VerificationStatus.SUSPENDED:
        updateData.isVerified = false;
        break;
    }

    return await prisma.lawyerProfile.update({
      where: { id: lawyerId },
      data: updateData
    });
  }

  /**
   * Check if lawyer meets requirements for status transition
   */
  private checkRequiredFields(lawyerProfile: any, requiredFields: string[]): string[] {
    const missingFields: string[] = [];

    for (const field of requiredFields) {
      switch (field) {
        case 'verificationDocuments':
          const requiredDocTypes = ['BAR_LICENSE', 'STATE_ID'];
          const submittedDocTypes = lawyerProfile.verificationDocuments?.map((doc: any) => doc.documentType) || [];
          const missingDocTypes = requiredDocTypes.filter(type => !submittedDocTypes.includes(type));

          if (missingDocTypes.length > 0) {
            missingFields.push(`Missing documents: ${missingDocTypes.join(', ')}`);
          }
          break;

        case 'licenseNumber':
          if (!lawyerProfile.licenseNumber) {
            missingFields.push('License number required');
          }
          break;

        case 'practiceAreas':
          if (!lawyerProfile.practiceAreas || lawyerProfile.practiceAreas.length === 0) {
            missingFields.push('Practice areas required');
          }
          break;

        case 'barAdmissionDate':
          if (!lawyerProfile.barAdmissionDate) {
            missingFields.push('Bar admission date required');
          }
          break;

        case 'barAdmissionState':
          if (!lawyerProfile.barAdmissionState) {
            missingFields.push('Bar admission state required');
          }
          break;
      }
    }

    return missingFields;
  }

  /**
   * Get verification progress percentage
   */
  getVerificationProgress(lawyerProfile: any): {
    percentage: number;
    completedSteps: string[];
    remainingSteps: string[];
  } {
    const allSteps = [
      'Basic profile information',
      'License number provided',
      'Practice areas selected',
      'Bar admission details',
      'Bar license document uploaded',
      'State ID document uploaded',
      'Professional liability insurance info',
      'Documents under review',
      'Verification completed'
    ];

    const completedSteps: string[] = [];
    const remainingSteps: string[] = [];

    // Check each step
    if (lawyerProfile.licenseNumber && lawyerProfile.practiceAreas?.length > 0) {
      completedSteps.push('Basic profile information');
    } else {
      remainingSteps.push('Basic profile information');
    }

    if (lawyerProfile.licenseNumber) {
      completedSteps.push('License number provided');
    } else {
      remainingSteps.push('License number provided');
    }

    if (lawyerProfile.practiceAreas?.length > 0) {
      completedSteps.push('Practice areas selected');
    } else {
      remainingSteps.push('Practice areas selected');
    }

    if (lawyerProfile.barAdmissionDate && lawyerProfile.barAdmissionState) {
      completedSteps.push('Bar admission details');
    } else {
      remainingSteps.push('Bar admission details');
    }

    const docs = lawyerProfile.verificationDocuments || [];
    const hasBarLicense = docs.some((doc: any) => doc.documentType === 'BAR_LICENSE');
    const hasStateId = docs.some((doc: any) => doc.documentType === 'STATE_ID');

    if (hasBarLicense) {
      completedSteps.push('Bar license document uploaded');
    } else {
      remainingSteps.push('Bar license document uploaded');
    }

    if (hasStateId) {
      completedSteps.push('State ID document uploaded');
    } else {
      remainingSteps.push('State ID document uploaded');
    }

    if (lawyerProfile.professionalLiabilityInsurance) {
      completedSteps.push('Professional liability insurance info');
    } else {
      remainingSteps.push('Professional liability insurance info');
    }

    // Status-based steps
    if (lawyerProfile.verificationStatus === VerificationStatus.UNDER_REVIEW) {
      completedSteps.push('Documents under review');
    } else if ([VerificationStatus.PENDING, VerificationStatus.DOCUMENTS_REQUIRED].includes(lawyerProfile.verificationStatus)) {
      remainingSteps.push('Documents under review');
    }

    if (lawyerProfile.verificationStatus === VerificationStatus.VERIFIED) {
      completedSteps.push('Verification completed');
    } else {
      remainingSteps.push('Verification completed');
    }

    const percentage = Math.round((completedSteps.length / allSteps.length) * 100);

    return {
      percentage,
      completedSteps,
      remainingSteps
    };
  }

  /**
   * Get next steps for lawyer based on current status
   */
  getNextSteps(lawyerProfile: any): string[] {
    const nextSteps: string[] = [];
    const status = lawyerProfile.verificationStatus;

    switch (status) {
      case VerificationStatus.PENDING:
        nextSteps.push('Complete your profile with all required information');
        nextSteps.push('Upload required verification documents');
        break;

      case VerificationStatus.DOCUMENTS_REQUIRED:
        const progress = this.getVerificationProgress(lawyerProfile);
        nextSteps.push(...progress.remainingSteps.filter(step =>
          step.includes('document') || step.includes('information')
        ));
        break;

      case VerificationStatus.UNDER_REVIEW:
        nextSteps.push('Your documents are being reviewed by our team');
        nextSteps.push('You will be notified once the review is complete');
        break;

      case VerificationStatus.VERIFIED:
        nextSteps.push('Your profile is verified and active');
        nextSteps.push('You can now receive consultation requests');
        break;

      case VerificationStatus.REJECTED:
        if (lawyerProfile.verificationNotes) {
          nextSteps.push(`Review feedback: ${lawyerProfile.verificationNotes}`);
        }
        nextSteps.push('Update your profile and resubmit documents');
        break;

      case VerificationStatus.SUSPENDED:
        nextSteps.push('Your profile has been suspended');
        nextSteps.push('Contact support for assistance');
        break;
    }

    return nextSteps;
  }

  /**
   * Check if lawyer can receive appointments
   */
  canReceiveAppointments(verificationStatus: VerificationStatus): boolean {
    return verificationStatus === VerificationStatus.VERIFIED;
  }

  /**
   * Get verification status display information
   */
  getStatusDisplayInfo(status: VerificationStatus): {
    label: string;
    color: string;
    description: string;
  } {
    const statusMap = {
      [VerificationStatus.PENDING]: {
        label: 'Pending',
        color: 'orange',
        description: 'Profile setup in progress'
      },
      [VerificationStatus.DOCUMENTS_REQUIRED]: {
        label: 'Documents Required',
        color: 'yellow',
        description: 'Upload verification documents to continue'
      },
      [VerificationStatus.UNDER_REVIEW]: {
        label: 'Under Review',
        color: 'blue',
        description: 'Documents are being reviewed by our team'
      },
      [VerificationStatus.VERIFIED]: {
        label: 'Verified',
        color: 'green',
        description: 'Profile verified and active'
      },
      [VerificationStatus.REJECTED]: {
        label: 'Rejected',
        color: 'red',
        description: 'Documents were rejected, please review and resubmit'
      },
      [VerificationStatus.SUSPENDED]: {
        label: 'Suspended',
        color: 'red',
        description: 'Profile temporarily suspended'
      }
    };

    return statusMap[status];
  }
}

export default new VerificationWorkflowService();