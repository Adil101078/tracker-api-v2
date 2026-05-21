import axios from 'axios';
import { logger } from '@core/logger';

export interface GeoData {
  status: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  query?: string;
}

/**
 * In-process cache keyed by IP. ip-api.com's free tier is HTTP-only and
 * rate-limited to ~45 req/min per source IP, so we never look up the same
 * IP twice while it stays warm. TTL keeps it from going stale forever.
 */
const cache = new Map<string, { data: GeoData; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Loopback / private / unspecified ranges — never worth a geo lookup. */
function isNonRoutable(ip: string): boolean {
  return (
    !ip ||
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('::ffff:127.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip === '0.0.0.0'
  );
}

/**
 * Resolve geolocation for an IP via ip-api.com.
 * Returns null on any failure or for non-routable IPs — callers must
 * treat geo as best-effort and never fail the job because of it.
 *
 * DISABLED by default. ip-api.com's free tier rate-limits at ~45 req/min
 * and was returning 429 Too Many Requests under our ingest load, which
 * spammed the logs without ever populating geo. Flip GEO_LOOKUP_ENABLED=true
 * to re-enable (consider adding a throttle / paid key first).
 */
export default async function getGeoData(
  ip?: string,
): Promise<GeoData | null> {
  if (process.env.GEO_LOOKUP_ENABLED !== 'true') return null;
  if (!ip || isNonRoutable(ip)) return null;

  const hit = cache.get(ip);
  if (hit && hit.expiresAt > Date.now()) return hit.data;

  try {
    const { data } = await axios.get<GeoData>(
      `http://ip-api.com/json/${encodeURIComponent(ip)}`,
      { timeout: 3000 },
    );

    if (data?.status !== 'success') {
      logger.warn(`Geo lookup non-success for ${ip}: ${data?.status}`);
      return null;
    }

    cache.set(ip, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (error) {
    logger.error(
      `Failed to get geolocation for ${ip}: ${(error as Error).message}`,
    );
    return null;
  }
}
