import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import constant from '@core/constants';

export type HourlyCompanyStatsDocument =
  HydratedDocument<HourlyCompanyStats>;

/**
 * Per-(company, hour) rollup "cube" that serves EVERY date-filtered
 * dashboard aggregation without touching the multi-million-row raw
 * collection.
 *
 * One document per company per UTC hour. A date-range query $matches
 * `bucketHour` between from/to (indexed) and re-aggregates across the
 * matched buckets — at most (hours-in-range x companies) docs, e.g. a
 * 90-day range over 5 companies = 90*24*5 ≈ 10.8k tiny docs vs scanning
 * 1M raw rows.
 *
 * WHY ADDITIVE-ONLY: every field is a sum/count/min/max so each new hit
 * is folded in with a single atomic $inc/$min/$max upsert — no
 * read-modify-write, safe under concurrent workers. Rates/averages are
 * NEVER stored; they are derived at read time from the sums.
 *
 * WHY NESTED MAPS (endpoints/statusBuckets/countries): keying a map by
 * the dimension value lets an update target one path atomically, e.g.
 * `$inc: { "endpoints./search.hits": 1 }`. MongoDB forbids '.' and '$'
 * in *stored* field names; endpoint paths and ISO country codes contain
 * neither, and statusBuckets keys are the fixed strings "1xx".."5xx".
 * Cardinality of all three is low, so the maps stay small. Reads expand
 * the maps with $objectToArray then $group.
 */
@Schema({
  collection:
    constant.MODELS.HOURLY_COMPANY_STATS.toLowerCase() + 's',
  versionKey: false,
  timestamps: true,
})
export class HourlyCompanyStats {
  @Prop({ type: String, required: true })
  companyCode: string;

  /** Hit's createdAt truncated to the start of its UTC hour. */
  @Prop({ type: Date, required: true })
  bucketHour: Date;

  // ---- flat totals (serve `summary` + recentSummary range metrics) ----
  @Prop({ type: Number, default: 0 })
  totalHits: number;

  @Prop({ type: Number, default: 0 })
  successCount: number;

  @Prop({ type: Number, default: 0 })
  errorCount: number;

  @Prop({ type: Number, default: 0 })
  blockedCount: number;

  @Prop({ type: Number, default: 0 })
  totalResponseTimeMs: number;

  /** Hits that actually carried a numeric responseTimeMs (avg divisor). */
  @Prop({ type: Number, default: 0 })
  responseTimeSamples: number;

  @Prop({ type: Date })
  firstHit?: Date;

  @Prop({ type: Date })
  lastHit?: Date;

  // ---- nested breakdowns (serve the group-by endpoints) ----
  /** endpoint -> { hits, successCount, totalResponseTimeMs }. */
  @Prop({ type: Object, default: {} })
  endpoints: Record<
    string,
    { hits: number; successCount: number; totalResponseTimeMs: number }
  >;

  /** "1xx".."5xx" -> count. */
  @Prop({ type: Object, default: {} })
  statusBuckets: Record<string, number>;

  /** countryCode -> { hits, country }. country kept for the display label. */
  @Prop({ type: Object, default: {} })
  countries: Record<string, { hits: number; country: string }>;
}

export const HourlyCompanyStatsSchema = SchemaFactory.createForClass(
  HourlyCompanyStats,
);

// Every read filters companyCode (optional) + a bucketHour range, then
// sorts/groups by bucketHour. This compound index serves all of them.
HourlyCompanyStatsSchema.index(
  { companyCode: 1, bucketHour: 1 },
  { unique: true },
);
// trafficOverTime with no companyCode filter scans by hour across all.
HourlyCompanyStatsSchema.index({ bucketHour: 1 });
