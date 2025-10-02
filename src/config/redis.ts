import IORedis, { Redis, RedisOptions } from 'ioredis';

let redisClient: Redis | null = null;

export const createRedisClient = (
  label?: string,
  overrides?: RedisOptions
): Redis => {
  const redisUrl = process.env.REDIS_URL;
  const baseOptions: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...(overrides ?? {})
  };

  const client = redisUrl
    ? new IORedis(redisUrl, baseOptions)
    : new IORedis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        ...baseOptions
      });

  const name = label ?? 'default';

  client.on('error', (error: Error) => {
    console.error(`[Redis:${name}] connection error`, error);
  });

  client.on('connect', () => {
    console.log(`[Redis:${name}] connection established`);
  });

  return client;
};

export const getRedisConnection = (): Redis => {
  if (!redisClient) {
    redisClient = createRedisClient('primary');
  }

  return redisClient;
};

export const closeRedisConnection = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
};
