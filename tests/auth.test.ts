import { PrismaClient } from '@prisma/client';

describe('Authentication Tests', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('User Authentication', () => {
    it('should create and retrieve users with different roles', async () => {
      // Create client user
      const clientUser = await prisma.user.create({
        data: {
          clerkUserId: `client_${Date.now()}`,
          email: `client.${Date.now()}@example.com`,
          firstName: 'Client',
          lastName: 'User',
          phone: '+1234567890',
          role: 'CLIENT'
        }
      });

      // Create lawyer user
      const lawyerUser = await prisma.user.create({
        data: {
          clerkUserId: `lawyer_${Date.now()}`,
          email: `lawyer.${Date.now()}@example.com`,
          firstName: 'Lawyer',
          lastName: 'User',
          phone: '+1234567891',
          role: 'LAWYER'
        }
      });

      expect(clientUser.role).toBe('CLIENT');
      expect(lawyerUser.role).toBe('LAWYER');

      // Test user retrieval
      const foundClient = await prisma.user.findUnique({
        where: { id: clientUser.id }
      });
      
      const foundLawyer = await prisma.user.findUnique({
        where: { id: lawyerUser.id }
      });

      expect(foundClient?.role).toBe('CLIENT');
      expect(foundLawyer?.role).toBe('LAWYER');

      // Clean up
      await prisma.user.delete({ where: { id: clientUser.id } });
      await prisma.user.delete({ where: { id: lawyerUser.id } });
    });

    it('should enforce unique email constraint', async () => {
      const email = `unique.test.${Date.now()}@example.com`;
      
      // Create first user
      const user1 = await prisma.user.create({
        data: {
          clerkUserId: `user1_${Date.now()}`,
          email: email,
          firstName: 'User',
          lastName: 'One',
          phone: '+1234567890',
          role: 'CLIENT'
        }
      });

      // Try to create second user with same email
      await expect(
        prisma.user.create({
          data: {
            clerkUserId: `user2_${Date.now()}`,
            email: email, // Same email
            firstName: 'User',
            lastName: 'Two',
            phone: '+1234567891',
            role: 'CLIENT'
          }
        })
      ).rejects.toThrow();

      // Clean up
      await prisma.user.delete({ where: { id: user1.id } });
    });

    it('should create lawyer profile for lawyer users', async () => {
      // Create lawyer user
      const lawyerUser = await prisma.user.create({
        data: {
          clerkUserId: `lawyer_profile_${Date.now()}`,
          email: `lawyer.profile.${Date.now()}@example.com`,
          firstName: 'Lawyer',
          lastName: 'WithProfile',
          phone: '+1234567892',
          role: 'LAWYER'
        }
      });

      // Create lawyer profile
      const lawyerProfile = await prisma.lawyerProfile.create({
        data: {
          userId: lawyerUser.id,
          licenseNumber: `LIC${Date.now()}`,
          practiceAreas: ['Corporate Law', 'Contract Law'],
          experience: 5,
          hourlyRate: 250.00,
          bio: 'Experienced corporate lawyer',
          isVerified: false
        }
      });

      expect(lawyerProfile.userId).toBe(lawyerUser.id);
      expect(lawyerProfile.practiceAreas).toContain('Corporate Law');
      expect(lawyerProfile.hourlyRate).toBe(250.00);

      // Test relationship
      const userWithProfile = await prisma.user.findUnique({
        where: { id: lawyerUser.id },
        include: { lawyerProfile: true }
      });

      expect(userWithProfile?.lawyerProfile).toBeDefined();
      expect(userWithProfile?.lawyerProfile?.licenseNumber).toBe(lawyerProfile.licenseNumber);

      // Clean up
      await prisma.lawyerProfile.delete({ where: { id: lawyerProfile.id } });
      await prisma.user.delete({ where: { id: lawyerUser.id } });
    });
  });
});