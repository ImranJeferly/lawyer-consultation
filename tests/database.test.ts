import { PrismaClient } from '@prisma/client';

describe('Database Connection Tests', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Basic Database Operations', () => {
    it('should connect to the database', async () => {
      const result = await prisma.$queryRaw`SELECT 1 as test`;
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should have the expected tables', async () => {
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `;
      
      expect(tables.length).toBeGreaterThan(50); // We should have 60 tables
      
      // Check for key tables
      const tableNames = tables.map(t => t.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('lawyer_profiles');
      expect(tableNames).toContain('appointments');
      expect(tableNames).toContain('payments');
      expect(tableNames).toContain('conversations');
    });

    it('should create and delete a test user', async () => {
      // Create a test user
      const testUser = await prisma.user.create({
        data: {
          clerkUserId: 'test_clerk_user_123',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          phone: '+1234567890',
          role: 'CLIENT'
        }
      });

      expect(testUser).toBeDefined();
      expect(testUser.email).toBe('test@example.com');
      expect(testUser.clerkUserId).toBe('test_clerk_user_123');

      // Verify user exists
      const foundUser = await prisma.user.findUnique({
        where: { id: testUser.id }
      });
      expect(foundUser).toBeDefined();
      expect(foundUser?.email).toBe('test@example.com');

      // Clean up
      await prisma.user.delete({
        where: { id: testUser.id }
      });

      // Verify deletion
      const deletedUser = await prisma.user.findUnique({
        where: { id: testUser.id }
      });
      expect(deletedUser).toBeNull();
    });
  });
});