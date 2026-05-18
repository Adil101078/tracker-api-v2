/**
 * Strongly-typed configuration loaded from environment variables.
 * Registered with @nestjs/config and consumed via ConfigService.
 */
export interface AppConfig {
  port: number;
  nodeEnv: string;
  corsOrigins: string[];
  mongoUri: string;
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
  };
  queue: {
    name: string;
    concurrency: number;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/tracker',
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
  },
  queue: {
    name: process.env.TRACKER_QUEUE_NAME ?? 'tracker-queue',
    concurrency: parseInt(process.env.TRACKER_QUEUE_CONCURRENCY ?? '10', 10),
  },
});
