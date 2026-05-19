import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import constant from '@core/constants';

export type CompanySummaryDocument = HydratedDocument<CompanySummary>;

/**
 * Real-time per-company rollup. One document per companyCode, updated
 * atomically on every tracker persist (see TrackerService.persist).
 *
 * This exists purely so the dashboard's "Recent API Hit Summary" table
 * and the company-code dropdown never have to $group / distinct over the
 * multi-million-row `trackers` collection. Read here = a few hundred docs
 * at most, fully index-served.
 *
 * Rates/averages are intentionally NOT stored — they are derived at read
 * time from the raw running totals (sums + counts). Storing only additive
 * quantities is what lets every update be a single atomic $inc/$min/$max
 * upsert with no read-modify-write race.
 */
@Schema({
  collection: constant.MODELS.COMPANY_SUMMARY.toLowerCase() + 's',
  versionKey: false,
  timestamps: true,
})
export class CompanySummary {
  @Prop({ type: String, required: true, unique: true })
  companyCode: string;

  @Prop({ type: Number, default: 0 })
  totalHits: number;

  @Prop({ type: Number, default: 0 })
  successCount: number;

  @Prop({ type: Number, default: 0 })
  errorCount: number;

  /** Sum of responseTimeMs across all hits; avg = this / totalHits. */
  @Prop({ type: Number, default: 0 })
  totalResponseTimeMs: number;

  /** Count of hits that actually carried a numeric responseTimeMs, so the
   * average divides by the right denominator (not every hit has one). */
  @Prop({ type: Number, default: 0 })
  responseTimeSamples: number;

  @Prop({ type: Date })
  firstHit?: Date;

  @Prop({ type: Date })
  lastHit?: Date;
}

export const CompanySummarySchema =
  SchemaFactory.createForClass(CompanySummary);

// Dropdown reads distinct codes; summary table sorts by most-recent hit.
// companyCode already has a unique index from @Prop({ unique: true }).
CompanySummarySchema.index({ lastHit: -1 });
