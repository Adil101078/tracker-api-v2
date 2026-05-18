import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { TrackerService } from '@modules/tracker/tracker.service';
import { SKIP_TRACKING } from '@core/decorators/skip-tracking.decorator';

/**
 * Auto-captures telemetry for every HTTP request handled by this service
 * and enqueues a tracker job. Self-instrumented mode: it observes calls
 * made TO this app — endpoint, method, statusCode, latency, IP, UA.
 *
 * Search metadata (companyCode, origin, ...) is read from the request body
 * when present so manual POST /tracker calls keep working as before.
 * Routes annotated with @SkipTracking() are ignored (avoids self-logging
 * the read/stats endpoints).
 */
@Injectable()
export class TrackingInterceptor implements NestInterceptor {
  constructor(
    private readonly trackerService: TrackerService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TRACKING, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();

    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      '';

    const body = (req.body ?? {}) as Record<string, unknown>;

    const finalize = (statusCode: number) => {
      // companyCode is required by the schema; fall back so telemetry-only
      // hits (e.g. health pings) still record without throwing.
      const companyCode =
        (body.companyCode as string) ||
        (req.headers['x-company-code'] as string) ||
        'UNKNOWN';

      void this.trackerService.enqueue({
        ...body,
        companyCode,
        endpoint: req.route?.path ?? req.originalUrl?.split('?')[0],
        httpMethod: req.method,
        statusCode,
        success: statusCode < 400,
        responseTimeMs: Date.now() - startedAt,
        userAgent: req.headers['user-agent'] as string,
        IP: ip,
      });
    };

    return next.handle().pipe(
      tap({
        next: () => finalize(res.statusCode),
        error: (err) => finalize(Number(err?.status) || 500),
      }),
    );
  }
}
