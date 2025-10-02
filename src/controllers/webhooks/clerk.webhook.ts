import { Request, Response } from 'express';
import { Webhook } from 'svix';
import prisma from '../../config/database';
import { getClerkWebhookSecret } from '../../config/clerk';

type RawBodyRequest = Request & { rawBody?: Buffer };

export const handleClerkWebhook = async (req: Request, res: Response) => {
  try {
    const webhookSecret = getClerkWebhookSecret();
    const webhook = new Webhook(webhookSecret);
    const rawBody = (req as RawBodyRequest).rawBody;

    if (!rawBody) {
      throw new Error('Missing raw request body for webhook verification');
    }

    const svixHeaders = {
      'svix-id': req.headers['svix-id'] as string,
      'svix-timestamp': req.headers['svix-timestamp'] as string,
      'svix-signature': req.headers['svix-signature'] as string,
    };

    if (!svixHeaders['svix-id'] || !svixHeaders['svix-timestamp'] || !svixHeaders['svix-signature']) {
      throw new Error('Missing Svix signature headers');
    }

    const evt = webhook.verify(rawBody.toString('utf8'), {
      'svix-id': svixHeaders['svix-id'],
      'svix-timestamp': svixHeaders['svix-timestamp'],
      'svix-signature': svixHeaders['svix-signature'],
    }) as { type: string; data: any };
    const { type, data } = evt;
    switch (type) {
      case 'user.created':
        await handleUserCreated(data);
        break;
      case 'user.updated':
        await handleUserUpdated(data);
        break;
      case 'user.deleted':
        await handleUserDeleted(data);
        break;
      default:
        console.log(`Unhandled webhook type: ${type}`);
    }
    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ message: 'Webhook processing failed' });
  }
};

const handleUserCreated = async (userData: any) => {
  try {
    const { id, email_addresses, first_name, last_name, phone_numbers, public_metadata } = userData;
    const userRole = public_metadata?.role || 'CLIENT';

    // MANDATORY: Phone number verification is required for ALL users
    const phoneNumber = phone_numbers?.find((phone: any) => phone.verification?.status === 'verified')?.phone_number;

    if (!phoneNumber) {
      console.error(`User ${id} creation failed: Phone verification is mandatory for all users`);
      throw new Error('Phone verification is required for all users');
    }

    const user = await prisma.user.create({
      data: {
        clerkUserId: id,
        email: email_addresses[0]?.email_address || '',
        firstName: first_name || '',
        lastName: last_name || '',
        phone: phoneNumber, // Now required and verified
        role: userRole,
        isVerified: userRole === 'CLIENT', // Clients are verified by default, lawyers need additional verification
      }
    });

    // If user is registering as a lawyer, create a lawyer profile (unverified by default)
    if (userRole === 'LAWYER') {
      await prisma.lawyerProfile.create({
        data: {
          userId: user.id,
          licenseNumber: '', // Will be filled when lawyer submits verification
          practiceAreas: [],
          experience: 0,
          hourlyRate: 0,
          bio: '',
          isVerified: false, // Lawyers start unverified and need professional verification
        }
      });
      console.log(`Lawyer profile created for user ${id} (unverified, phone verified: ${phoneNumber})`);
    }

    console.log(`User ${id} synced to database with role: ${userRole}, verified phone: ${phoneNumber}`);
  } catch (error) {
    console.error('Error creating user:', error);
    throw error; // Re-throw to ensure webhook fails if phone verification is missing
  }
};

const handleUserUpdated = async (userData: any) => {
  try {
    const { id, email_addresses, first_name, last_name, phone_numbers, public_metadata } = userData;
    const newRole = public_metadata?.role || 'CLIENT';

    // MANDATORY: Phone number verification is required for ALL users
    const phoneNumber = phone_numbers?.find((phone: any) => phone.verification?.status === 'verified')?.phone_number;

    if (!phoneNumber) {
      console.error(`User ${id} update failed: Phone verification is mandatory for all users`);
      // Don't throw error on update - just log the issue but allow update to continue
      console.warn(`User ${id} update continuing with existing phone number`);
    }

    // Get current user to check for role changes
    const currentUser = await prisma.user.findUnique({
      where: { clerkUserId: id },
      include: { lawyerProfile: true }
    });

    if (!currentUser) {
      console.log(`User ${id} not found during update`);
      return;
    }

    // Update user information
    const updatedUser = await prisma.user.update({
      where: { clerkUserId: id },
      data: {
        email: email_addresses[0]?.email_address || '',
        firstName: first_name || '',
        lastName: last_name || '',
        phone: phoneNumber || currentUser.phone, // Use verified phone or keep existing
        role: newRole,
        isVerified: newRole === 'CLIENT' ? true : currentUser.isVerified,
      }
    });

    // If role changed from CLIENT to LAWYER, create lawyer profile
    if (currentUser.role === 'CLIENT' && newRole === 'LAWYER' && !currentUser.lawyerProfile) {
      await prisma.lawyerProfile.create({
        data: {
          userId: updatedUser.id,
          licenseNumber: '',
          practiceAreas: [],
          experience: 0,
          hourlyRate: 0,
          bio: '',
          isVerified: false,
        }
      });
      console.log(`Lawyer profile created for user ${id} after role change (phone verified: ${phoneNumber || 'existing'})`);
    }

    console.log(`User ${id} updated in database with role: ${newRole}, phone: ${phoneNumber || 'existing'}`);
  } catch (error) {
    console.error('Error updating user:', error);
  }
};

const handleUserDeleted = async (userData: any) => {
  try {
    const { id } = userData;
    await prisma.user.delete({
      where: { clerkUserId: id }
    });
    console.log(`User ${id} deleted from database`);
  } catch (error) {
    console.error('Error deleting user:', error);
  }
};
