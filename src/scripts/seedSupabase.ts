import prisma from '../config/database';
import { UserRole } from '@prisma/client';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const practiceAreas = [
  {
    name: 'Family Law',
    description: 'Divorce, child custody, guardianship, adoption, and family mediation services.',
  },
  {
    name: 'Corporate Law',
    description: 'Entity formation, compliance, corporate governance, and mergers & acquisitions.',
  },
  {
    name: 'Criminal Defense',
    description: 'Defense strategies, plea negotiations, and representation for criminal matters.',
  },
  {
    name: 'Intellectual Property',
    description: 'Trademark, patent, copyright, and IP portfolio management guidance.',
  },
  {
    name: 'Real Estate Law',
    description: 'Property transactions, lease agreements, zoning, and construction disputes.',
  },
  {
    name: 'Immigration Law',
    description: 'Visa processing, residency, citizenship, and compliance advisory.',
  },
  {
    name: 'Employment Law',
    description: 'Contracts, compliance, workplace investigations, and dispute resolution.',
  },
  {
    name: 'Tax Law',
    description: 'Tax planning, compliance, audits, and cross-border transaction support.',
  },
  {
    name: 'Banking & Finance',
    description: 'Regulatory compliance, lending, fintech, and capital markets advisory.',
  },
  {
    name: 'Dispute Resolution',
    description: 'Mediation, arbitration, and litigation strategy for commercial disputes.',
  },
];

type RoleSeed = {
  role: UserRole;
  email: string;
  clerkUserId: string;
  firstName: string;
  lastName: string;
  phone: string;
  isVerified: boolean;
  practiceAreas?: string[];
  licenseNumber?: string;
  experience?: number;
  hourlyRate?: number;
  bio?: string;
};

const roleSeeds: RoleSeed[] = [
  {
    role: UserRole.ADMIN,
    email: process.env.SEED_ADMIN_EMAIL || 'admin.seed@lawyer.consultation',
    clerkUserId: process.env.SEED_ADMIN_CLERK_ID || 'seed-admin-user',
    firstName: 'Seed',
    lastName: 'Admin',
    phone: '+15550000001',
    isVerified: true,
  },
  {
    role: UserRole.LAWYER,
    email: process.env.SEED_LAWYER_EMAIL || 'lawyer.seed@lawyer.consultation',
    clerkUserId: process.env.SEED_LAWYER_CLERK_ID || 'seed-lawyer-user',
    firstName: 'Seed',
    lastName: 'Lawyer',
    phone: '+15550000002',
    isVerified: false,
    practiceAreas: ['Family Law', 'Corporate Law'],
    licenseNumber: process.env.SEED_LAWYER_LICENSE || 'SEED-LAW-001',
    experience: 5,
    hourlyRate: 180,
    bio: 'Seed lawyer profile for onboarding and QA flows.',
  },
  {
    role: UserRole.CLIENT,
    email: process.env.SEED_CLIENT_EMAIL || 'client.seed@lawyer.consultation',
    clerkUserId: process.env.SEED_CLIENT_CLERK_ID || 'seed-client-user',
    firstName: 'Seed',
    lastName: 'Client',
    phone: '+15550000003',
    isVerified: true,
  },
];

async function seedPracticeAreas() {
  console.log('Seeding baseline practice areas...');

  for (const [index, area] of practiceAreas.entries()) {
    const slug = slugify(area.name);

    await prisma.practiceArea.upsert({
      where: { slug },
      update: {
        name: area.name,
        description: area.description,
        isActive: true,
        sortOrder: index,
      },
      create: {
        name: area.name,
        description: area.description,
        slug,
        sortOrder: index,
      },
    });
  }

  console.log('✔ Practice areas seeded.');
}

async function seedRoleUsers() {
  console.log('Seeding baseline role holders...');

  for (const seed of roleSeeds) {
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      update: {
        firstName: seed.firstName,
        lastName: seed.lastName,
        phone: seed.phone,
        role: seed.role,
        isVerified: seed.isVerified,
      },
      create: {
        clerkUserId: seed.clerkUserId,
        email: seed.email,
        firstName: seed.firstName,
        lastName: seed.lastName,
        phone: seed.phone,
        role: seed.role,
        isVerified: seed.isVerified,
      },
    });

    if (seed.role === UserRole.LAWYER) {
      await prisma.lawyerProfile.upsert({
        where: { userId: user.id },
        update: {
          practiceAreas: seed.practiceAreas ?? [],
          licenseNumber: seed.licenseNumber,
          experience: seed.experience,
          hourlyRate: seed.hourlyRate,
          bio: seed.bio,
        },
        create: {
          userId: user.id,
          practiceAreas: seed.practiceAreas ?? [],
          licenseNumber: seed.licenseNumber!,
          experience: seed.experience!,
          hourlyRate: seed.hourlyRate!,
          bio: seed.bio,
        },
      });
    }
  }

  console.log('✔ Role holders seeded.');
}

async function main() {
  try {
    await prisma.$connect();

    await seedPracticeAreas();
    await seedRoleUsers();

    console.log('✅ Supabase baseline data seeded successfully.');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
