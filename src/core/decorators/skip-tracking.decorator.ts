import { SetMetadata } from '@nestjs/common';

export const SKIP_TRACKING = 'skipTracking';

/**
 * Mark a route (or controller) so the TrackingInterceptor does NOT
 * record a tracker hit for it — used for read/stats endpoints so the
 * dashboard's own queries don't pollute the api-hit data.
 */
export const SkipTracking = () => SetMetadata(SKIP_TRACKING, true);
