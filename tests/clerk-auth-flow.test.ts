import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { createAuthRouter, type AuthRouterDependencies } from '../src/routes/auth.routes';

const CLERK_TOKEN = 'test-clerk-token';
const CLERK_USER_ID = 'clerk_user_test_001';

interface StoredUser {
  id: string;
  clerkUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: UserRole;
  isVerified: boolean;
}

interface StoredLawyerProfile {
  userId: string;
  licenseNumber: string;
  practiceAreas: string[];
  experience: number;
  hourlyRate: number;
  bio: string;
  isVerified: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const usersById = new Map<string, StoredUser>();
const usersByClerkId = new Map<string, string>();
const lawyerProfilesByUserId = new Map<string, StoredLawyerProfile>();

const clearStores = () => {
  usersById.clear();
  usersByClerkId.clear();
  lawyerProfilesByUserId.clear();
};

const addUser = (user: Omit<StoredUser, 'id'> & { id?: string }): StoredUser => {
  const id = user.id ?? `user_${Math.random().toString(36).slice(2, 10)}`;
  const stored: StoredUser = { ...user, id };
  usersById.set(id, stored);
  usersByClerkId.set(stored.clerkUserId, id);
  return stored;
};

const extractPrimitive = <T extends string | number | boolean>(value: unknown): T | undefined => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as T;
  }

  if (value && typeof value === 'object') {
    if ('equals' in (value as Record<string, unknown>)) {
      const equalsValue = (value as Record<string, unknown>).equals;
      if (typeof equalsValue === 'string' || typeof equalsValue === 'number' || typeof equalsValue === 'boolean') {
        return equalsValue as T;
      }
    }

    if ('in' in (value as Record<string, unknown>)) {
      const inValue = (value as Record<string, unknown>).in;
      if (Array.isArray(inValue)) {
        return inValue[0] as T;
      }
    }
  }

  return undefined;
};

const findUser = (where: { id?: unknown; clerkUserId?: unknown; email?: unknown }) => {
  const id = extractPrimitive<string>(where.id);
  if (id) {
    return usersById.get(id) ?? null;
  }

  const clerkId = extractPrimitive<string>(where.clerkUserId);
  if (clerkId) {
    const resolvedId = usersByClerkId.get(clerkId);
    return resolvedId ? usersById.get(resolvedId) ?? null : null;
  }

  const email = extractPrimitive<string>(where.email);
  if (email) {
    for (const user of usersById.values()) {
      if (user.email === email) {
        return user;
      }
    }
  }

  return null;
};

const userFindUniqueImpl = async ({ where, include }: any) => {
  const user = findUser(where ?? {});
  if (!user) {
    return null;
  }

  const base = clone(user);

  if (include?.lawyerProfile) {
    return {
      ...base,
      lawyerProfile: clone(lawyerProfilesByUserId.get(user.id) ?? null),
    };
  }

  return base;
};

const userFindManyImpl = async ({ where, include }: any) => {
  const results = Array.from(usersById.values()).filter((user) => {
    if (!where) {
      return true;
    }

    if (where.role) {
      if (typeof where.role === 'string' && user.role !== where.role) {
        return false;
      }

      if (typeof where.role === 'object') {
        if ('equals' in where.role && typeof where.role.equals === 'string') {
          if (user.role !== where.role.equals) {
            return false;
          }
        }

        if ('in' in where.role && Array.isArray(where.role.in)) {
          if (!where.role.in.includes(user.role)) {
            return false;
          }
        }
      }
    }

    const isVerified = extractPrimitive<boolean>(where.isVerified);
    if (typeof isVerified === 'boolean' && user.isVerified !== isVerified) {
      return false;
    }

    return true;
  });

  return results.map((user) => {
    if (!include?.lawyerProfile) {
      return clone(user);
    }
    return {
      ...clone(user),
      lawyerProfile: clone(lawyerProfilesByUserId.get(user.id) ?? null),
    };
  });
};

const userUpdateImpl = async ({ where, data }: any) => {
  const existing = findUser(where ?? {});
  if (!existing) {
    throw new Error('User not found');
  }

  const updated: StoredUser = {
    ...existing,
    ...data,
    clerkUserId: data.clerkUserId ?? existing.clerkUserId,
  };

  usersById.set(updated.id, updated);
  usersByClerkId.set(updated.clerkUserId, updated.id);
  return clone(updated);
};

const lawyerCreateImpl = async ({ data }: any) => {
  const profile: StoredLawyerProfile = {
    userId: data.userId,
    licenseNumber: data.licenseNumber,
    practiceAreas: data.practiceAreas ?? [],
    experience: data.experience ?? 0,
    hourlyRate: data.hourlyRate ?? 0,
    bio: data.bio ?? '',
    isVerified: data.isVerified ?? false,
  };

  lawyerProfilesByUserId.set(profile.userId, profile);
  return clone(profile);
};

const lawyerFindUniqueImpl = async ({ where }: any) => {
  const userId = extractPrimitive<string>(where?.userId);
  if (!userId) {
    return null;
  }
  return clone(lawyerProfilesByUserId.get(userId) ?? null);
};

const lawyerUpdateImpl = async ({ where, data }: any) => {
  const userId = extractPrimitive<string>(where?.userId);
  if (!userId) {
    const error: any = new Error('Lawyer profile not found');
    error.code = 'P2025';
    throw error;
  }

  const existing = lawyerProfilesByUserId.get(userId);
  if (!existing) {
    const error: any = new Error('Lawyer profile not found');
    error.code = 'P2025';
    throw error;
  }

  const updated: StoredLawyerProfile = {
    ...existing,
    ...data,
    practiceAreas: data.practiceAreas ?? existing.practiceAreas,
  };

  lawyerProfilesByUserId.set(userId, updated);
  return clone(updated);
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(userFindUniqueImpl),
    findMany: jest.fn(userFindManyImpl),
    update: jest.fn(userUpdateImpl),
  },
  lawyerProfile: {
    create: jest.fn(lawyerCreateImpl),
    findUnique: jest.fn(lawyerFindUniqueImpl),
    update: jest.fn(lawyerUpdateImpl),
  },
};

const applyMockImplementations = () => {
  mockPrisma.user.findUnique.mockImplementation(userFindUniqueImpl);
  mockPrisma.user.findMany.mockImplementation(userFindManyImpl);
  mockPrisma.user.update.mockImplementation(userUpdateImpl);
  mockPrisma.lawyerProfile.create.mockImplementation(lawyerCreateImpl);
  mockPrisma.lawyerProfile.findUnique.mockImplementation(lawyerFindUniqueImpl);
  mockPrisma.lawyerProfile.update.mockImplementation(lawyerUpdateImpl);
};

const prismaDependency = mockPrisma as unknown as AuthRouterDependencies['prisma'];

const withPrismaRetry: AuthRouterDependencies['withPrismaRetry'] = async (operation) => operation();

const authenticateClerk: RequestHandler = (req, res, next) => {
  const header = req.header('Authorization');
  if (!header) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== CLERK_TOKEN) {
    return res.status(401).json({ message: 'Authentication failed' });
  }

  const user = findUser({ clerkUserId: CLERK_USER_ID });
  if (!user) {
    return res.status(401).json({ message: 'User not found in database' });
  }

  req.auth = {
    userId: CLERK_USER_ID,
    sessionId: 'sess_test_123',
  };

  req.user = {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  };

  req.sessionClaims = {
    sub: CLERK_USER_ID,
  };

  return next();
};

const requireLawyer: RequestHandler = (req, res, next) => {
  if (req.user?.role !== UserRole.LAWYER) {
    return res.status(403).json({ message: 'Lawyer access required' });
  }
  return next();
};

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== UserRole.ADMIN) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  return next();
};

const buildApp = () => {
  const router = createAuthRouter({
    prisma: prismaDependency,
    withPrismaRetry,
    authenticateClerk,
    requireLawyer,
    requireAdmin,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return app;
};

describe('Clerk-authenticated lifecycle', () => {
  const baseEmail = 'clerk.test@example.com';
  let baseUserId: string;
  let app: express.Express;

  beforeEach(() => {
    clearStores();
    applyMockImplementations();

    const baseUser = addUser({
      id: 'user_seed',
      clerkUserId: CLERK_USER_ID,
      email: baseEmail,
      firstName: 'Clerk',
      lastName: 'Tester',
      phone: '+15551234567',
      role: UserRole.CLIENT,
      isVerified: true,
    });
    baseUserId = baseUser.id;
    app = buildApp();
  });

  it('allows registration via the placeholder endpoint', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'new.user@example.com',
        password: 'StrongPassword123!',
        firstName: 'New',
        lastName: 'User',
        role: 'CLIENT',
      });

    expect(response.status).toBe(201);
    expect(response.body.message).toMatch(/Registration endpoint ready/i);
  });

  it('allows login via the placeholder endpoint', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: baseEmail, password: 'irrelevant' });

    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/Login endpoint ready/i);
  });

  it('returns the current profile when presented with a valid Clerk token', async () => {
    const response = await request(app)
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${CLERK_TOKEN}`);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: baseUserId },
      include: { lawyerProfile: true },
    });
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(baseEmail);
  });

  it('promotes a client to lawyer and creates a baseline lawyer profile', async () => {
    const response = await request(app)
      .put('/api/auth/role')
      .set('Authorization', `Bearer ${CLERK_TOKEN}`)
      .send({ role: 'LAWYER' });

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('LAWYER');

    const profile = lawyerProfilesByUserId.get(baseUserId);
    expect(profile).toBeDefined();
    expect(profile?.isVerified).toBe(false);
    expect(profile?.practiceAreas).toEqual([]);
  });

  it('updates the lawyer profile for authenticated lawyers', async () => {
    await request(app)
      .put('/api/auth/role')
      .set('Authorization', `Bearer ${CLERK_TOKEN}`)
      .send({ role: 'LAWYER' });

    const updateResponse = await request(app)
      .put('/api/auth/lawyer/profile')
      .set('Authorization', `Bearer ${CLERK_TOKEN}`)
      .send({
        licenseNumber: 'LAW-1234',
        practiceAreas: ['Family Law', 'Corporate Law'],
        experience: 8,
        hourlyRate: 225,
        bio: 'Seasoned attorney with multi-jurisdictional experience.',
      });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.profile.practiceAreas).toContain('Family Law');
    expect(updateResponse.body.profile.hourlyRate).toBe(225);
  });
});
