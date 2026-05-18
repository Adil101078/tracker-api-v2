import { Logger } from '@nestjs/common';

/**
 * Lightweight shared logger for use outside the DI container
 * (e.g. utility functions). Inside providers, prefer the
 * injected NestJS `Logger`.
 */
export const logger = new Logger('App');
