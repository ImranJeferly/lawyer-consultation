// Jest setup file
console.log('Jest setup loaded');

// Set test environment variables
process.env.NODE_ENV = 'test';

process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_jest_secret';
process.env.CLERK_WEBHOOK_SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET || 'whsec_jest_secret';
process.env.CLERK_JWT_ISSUER = process.env.CLERK_JWT_ISSUER || 'https://clerk.jest.example.com';
process.env.CLERK_JWT_AUDIENCE = process.env.CLERK_JWT_AUDIENCE || 'jest-lawyer-consultation';
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || 'pk_test_jest_publishable';

// Add custom matchers
expect.extend({
  toBeValidDate(received) {
    const pass = received instanceof Date && !isNaN(received.getTime());
    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid date`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid date`,
        pass: false,
      };
    }
  },
});