import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import constant from '@core/constants';

export type TrackerDocument = HydratedDocument<Tracker>;

/**
 * Stores a single api-hit / api-call record.
 *
 * Fields fall into three groups:
 *  1. Search metadata  — sent by the caller (origin, destination, ...).
 *  2. Telemetry        — auto-captured by the TrackingInterceptor
 *                         (endpoint, method, statusCode, responseTimeMs, userAgent).
 *  3. Geo              — resolved from IP by the worker via ip-api.com.
 */
@Schema({
  collection: constant.MODELS.TRACKER.toLowerCase() + 's',
  versionKey: false,
  timestamps: true,
})
export class Tracker {
  // ---- search metadata (caller-supplied) ----
  // Not individually indexed: companyCode always leads a compound index
  // (see bottom of file), which also covers companyCode-only lookups.
  @Prop({ type: String, required: true })
  companyCode: string;

  @Prop({ type: String })
  credentialCode?: string;

  @Prop({ type: String })
  secretKey?: string;

  @Prop({ type: String })
  referralUrl?: string;

  @Prop({ type: String })
  searchId?: string;

  @Prop({ type: String })
  origin?: string;

  @Prop({ type: String })
  destination?: string;

  @Prop({ type: String })
  classOfService?: string;

  @Prop({ type: String })
  adults?: string;

  @Prop({ type: String })
  child?: string;

  @Prop({ type: String })
  infants?: string;

  @Prop({ type: String })
  currency?: string;

  @Prop({ type: String, default: '' })
  departureDate?: string;

  @Prop({ type: String, default: '' })
  returnDate?: string;

  // ---- telemetry (auto-captured by interceptor) ----
  // NOTE: single-field `index: true` flags were intentionally removed here.
  // At millions of rows every extra index slows writes; these fields are
  // only ever queried alongside companyCode + createdAt, so they are served
  // by the compound indexes declared at the bottom of this file instead.
  @Prop({ type: String })
  endpoint?: string;

  @Prop({ type: String })
  httpMethod?: string;

  @Prop({ type: Number })
  statusCode?: number;

  @Prop({ type: Boolean })
  success?: boolean;

  @Prop({ type: Number })
  responseTimeMs?: number;

  @Prop({ type: String })
  userAgent?: string;

  @Prop({ type: Boolean, default: false })
  isBot?: boolean;

  @Prop({ type: Boolean, default: false })
  isBlocked?: boolean;

  // ---- network / geo ----
  @Prop({ type: String })
  IP?: string;

  @Prop({ type: String })
  country?: string;

  @Prop({ type: String })
  countryCode?: string;

  @Prop({ type: String })
  region?: string;

  @Prop({ type: String })
  regionName?: string;

  @Prop({ type: String })
  city?: string;

  @Prop({ type: Number })
  lat?: number;

  @Prop({ type: Number })
  lon?: number;

  @Prop({ type: String })
  timezone?: string;

  @Prop({ type: String })
  isp?: string;

  @Prop({ type: String })
  org?: string;
}

export const TrackerSchema = SchemaFactory.createForClass(Tracker);

/**
 * Indexes are designed for the dashboard's exact query shapes. Every
 * dashboard query filters by companyCode (equality) and usually a
 * createdAt range, then groups by one telemetry/geo field. Following the
 * ESR rule (Equality, Sort/Range, then the grouped/projected field) each
 * compound index lets that pipeline use an index scan instead of a
 * collection scan over millions of documents.
 *
 * companyCode leads every index, so plain { companyCode } and
 * { companyCode, createdAt } lookups (findRecent, list) are also covered
 * by the prefix of these — no separate single-field indexes needed.
 */

// findRecent / list — recent hits for a company, newest first.
TrackerSchema.index({ companyCode: 1, createdAt: -1 });

// summary / traffic-over-time — scan a company's hits within a date range.
TrackerSchema.index({ companyCode: 1, createdAt: 1 });

// top-endpoints — $match company+range, $group by endpoint.
TrackerSchema.index({ companyCode: 1, createdAt: 1, endpoint: 1 });

// status-distribution — $match company+range, $group by statusCode.
TrackerSchema.index({ companyCode: 1, createdAt: 1, statusCode: 1 });

// hits-by-country — $match company+range+country, $group by country.
TrackerSchema.index({ companyCode: 1, createdAt: 1, country: 1 });

// summary success/error & blocked breakdowns over a range.
TrackerSchema.index({ companyCode: 1, success: 1, createdAt: 1 });
TrackerSchema.index({ companyCode: 1, isBlocked: 1, createdAt: 1 });

// Operational lookups: trace a single request by id, or by source IP.
TrackerSchema.index({ searchId: 1 }, { sparse: true });
TrackerSchema.index({ IP: 1, createdAt: -1 });

// TTL: optionally auto-expire raw hits to keep the collection bounded at
// scale. OFF by default (would silently delete history). Enable by setting
// TRACKER_TTL_DAYS — and roll older data into summary collections first if
// you need long-term reporting.
const ttlDays = parseInt(process.env.TRACKER_TTL_DAYS ?? '0', 10);
if (ttlDays > 0) {
  TrackerSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: ttlDays * 24 * 60 * 60 },
  );
}
