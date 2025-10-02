import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const withPrismaRetry = async <T>(operation: () => Promise<T>, maxRetries = 1): Promise<T> => {
	let attempt = 0;

	while (attempt <= maxRetries) {
		try {
			await prisma.$connect();
			return await operation();
		} catch (error) {
			const isConnectionReset =
				error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P1017';

			if (isConnectionReset && attempt < maxRetries) {
				attempt += 1;
				await prisma.$disconnect();
				continue;
			}
			throw error;
		}
	}

	throw new Error('Exceeded maximum Prisma retry attempts');
};

export default prisma;