import { createClerkClient, VerifyTokenOptions } from '@clerk/backend';

const isTestEnv = process.env.NODE_ENV === 'test';

const readEnv = (key: string, { required }: { required: boolean }): string | undefined => {
  const value = process.env[key];
  if (!value && required && !isTestEnv) {
    throw new Error(`Missing required Clerk environment variable: ${key}`);
  }
  return value;
};

const parseCsv = (value?: string | null): string[] =>
  value
    ?.split(',')
    .map((segment) => segment.trim())
    .filter(Boolean) ?? [];

const secretKey =
  readEnv('CLERK_SECRET_KEY', { required: true }) ?? 'sk_test_placeholder';

const publishableKey =
  readEnv('CLERK_PUBLISHABLE_KEY', { required: false }) ??
  readEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', { required: false }) ??
  '';

const webhookSecret =
  readEnv('CLERK_WEBHOOK_SIGNING_SECRET', { required: true }) ?? 'whsec_test_placeholder';

const issuer = readEnv('CLERK_JWT_ISSUER', { required: false });
const jwtAudiences = parseCsv(readEnv('CLERK_JWT_AUDIENCE', { required: false }));
const authorizedParties = parseCsv(readEnv('CLERK_AUTHORIZED_PARTIES', { required: false }));

if (!issuer && !isTestEnv) {
  throw new Error('CLERK_JWT_ISSUER is required outside of test environments');
}

export const clerkEnv = {
  secretKey,
  webhookSecret,
  jwtIssuer: issuer,
  jwtAudiences,
  authorizedParties,
  publishableKey,
};

const clockSkewRaw = Number.parseInt(process.env.CLERK_JWT_CLOCK_SKEW ?? '5000', 10);

export const clerkJwtVerification: VerifyTokenOptions = {
  secretKey,
  audience: jwtAudiences.length ? jwtAudiences : undefined,
  authorizedParties: authorizedParties.length ? authorizedParties : undefined,
  clockSkewInMs: Number.isFinite(clockSkewRaw) ? clockSkewRaw : 5000,
};

export const clerkClient = createClerkClient({
  secretKey,
  publishableKey: publishableKey || undefined,
});

export const getClerkUser = async (userId: string) => {
  try {
    return await clerkClient.users.getUser(userId);
  } catch (error) {
    console.error('Error fetching user from Clerk:', error);
    return null;
  }
};

export const getClerkWebhookSecret = (): string => webhookSecret;
