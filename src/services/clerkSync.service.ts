import { clerkClient } from '../config/clerk';
import { User } from '@prisma/client';

interface ClerkSyncResult {
  success: boolean;
  error?: string;
  syncedFields?: string[];
}

class ClerkSyncService {
  /**
   * Sync user data to Clerk
   */
  async syncUserToClerk(user: User, updatedFields: Partial<User>): Promise<ClerkSyncResult> {
    try {
      const syncedFields: string[] = [];
      const updateData: any = {};

      // Sync first name
      if (updatedFields.firstName && updatedFields.firstName !== user.firstName) {
        updateData.firstName = updatedFields.firstName;
        syncedFields.push('firstName');
      }

      // Sync last name
      if (updatedFields.lastName && updatedFields.lastName !== user.lastName) {
        updateData.lastName = updatedFields.lastName;
        syncedFields.push('lastName');
      }

      // Sync phone number
      if (updatedFields.phone && updatedFields.phone !== user.phone) {
        // For phone updates, we need to handle it specially in Clerk
        updateData.phoneNumbers = [{
          phoneNumber: updatedFields.phone,
          verified: true // Assuming it's already verified in our system
        }];
        syncedFields.push('phone');
      }

      // Only make API call if there are changes
      if (Object.keys(updateData).length > 0) {
        await clerkClient.users.updateUser(user.clerkUserId, updateData);
      }

      return {
        success: true,
        syncedFields
      };
    } catch (error) {
      console.error('Clerk sync error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown sync error',
        syncedFields: []
      };
    }
  }

  /**
   * Sync email change (requires special handling)
   */
  async syncEmailChange(user: User, newEmail: string): Promise<ClerkSyncResult> {
    try {
      // Email changes in Clerk require using the email address API
      // Note: This is a simplified approach - in production you might want to
      // use Clerk's email address management endpoints directly
      await clerkClient.users.updateUser(user.clerkUserId, {
        // For now, we'll skip direct email updates as they require special handling
        // This would typically involve creating a new email address and verifying it
        publicMetadata: {
          pendingEmailChange: newEmail,
          emailChangeRequestedAt: new Date().toISOString()
        }
      });

      return {
        success: true,
        syncedFields: ['email_pending']
      };
    } catch (error) {
      console.error('Email sync error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Email sync failed'
      };
    }
  }

  /**
   * Update user metadata in Clerk
   */
  async updateUserMetadata(user: User, metadata: Record<string, any>): Promise<ClerkSyncResult> {
    try {
      await clerkClient.users.updateUser(user.clerkUserId, {
        publicMetadata: {
          ...metadata,
          lastProfileUpdate: new Date().toISOString()
        }
      });

      return {
        success: true,
        syncedFields: ['metadata']
      };
    } catch (error) {
      console.error('Metadata sync error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Metadata sync failed'
      };
    }
  }

  /**
   * Get user data from Clerk
   */
  async getUserFromClerk(clerkUserId: string): Promise<any> {
    try {
      return await clerkClient.users.getUser(clerkUserId);
    } catch (error) {
      console.error('Error fetching user from Clerk:', error);
      return null;
    }
  }

  /**
   * Verify sync status between local and Clerk data
   */
  async verifySyncStatus(user: User): Promise<{
    inSync: boolean;
    differences: string[];
    clerkData?: any;
  }> {
    try {
      const clerkUser = await this.getUserFromClerk(user.clerkUserId);
      if (!clerkUser) {
        return { inSync: false, differences: ['User not found in Clerk'] };
      }

      const differences: string[] = [];

      // Check first name
      if (clerkUser.firstName !== user.firstName) {
        differences.push(`firstName: local(${user.firstName}) vs clerk(${clerkUser.firstName})`);
      }

      // Check last name
      if (clerkUser.lastName !== user.lastName) {
        differences.push(`lastName: local(${user.lastName}) vs clerk(${clerkUser.lastName})`);
      }

      // Check email
      const clerkEmail = clerkUser.emailAddresses?.[0]?.emailAddress;
      if (clerkEmail !== user.email) {
        differences.push(`email: local(${user.email}) vs clerk(${clerkEmail})`);
      }

      // Check phone
      const clerkPhone = clerkUser.phoneNumbers?.[0]?.phoneNumber;
      if (clerkPhone !== user.phone) {
        differences.push(`phone: local(${user.phone}) vs clerk(${clerkPhone})`);
      }

      return {
        inSync: differences.length === 0,
        differences,
        clerkData: clerkUser
      };
    } catch (error) {
      console.error('Sync verification error:', error);
      return {
        inSync: false,
        differences: ['Error verifying sync status']
      };
    }
  }

  /**
   * Handle sync failures gracefully
   */
  handleSyncFailure(error: any, context: string): void {
    console.error(`Clerk sync failure in ${context}:`, error);

    // Log for monitoring/alerting
    // In production, you might want to:
    // 1. Queue for retry
    // 2. Send to error tracking service
    // 3. Alert administrators

    // For now, just log the error
    console.log('Sync failure logged for manual review');
  }

  /**
   * Batch sync multiple fields
   */
  async batchSyncToClerk(user: User, updates: Partial<User>): Promise<ClerkSyncResult> {
    try {
      const result = await this.syncUserToClerk(user, updates);

      // If sync fails, we should still continue with local updates
      // but log the sync failure for later retry
      if (!result.success) {
        this.handleSyncFailure(result.error, 'batchSync');
      }

      return result;
    } catch (error) {
      this.handleSyncFailure(error, 'batchSync');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Batch sync failed'
      };
    }
  }
}

export default new ClerkSyncService();