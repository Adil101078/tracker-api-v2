import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { FilterQuery, Model, PipelineStage } from 'mongoose';
import constant from '@core/constants';
import { CreateTrackerDto } from './dto/create-tracker.dto';
import { Tracker, TrackerDocument } from './schemas/tracker.schema';
import {
  CompanySummary,
  CompanySummaryDocument,
} from './schemas/company-summary.schema';
import {
  HourlyCompanyStats,
  HourlyCompanyStatsDocument,
} from './schemas/hourly-company-stats.schema';

export interface StatsQuery {
  companyCode?: string;
  from?: string;
  to?: string;
}

export type Granularity = 'minute' | 'hour' | 'day';

export interface RecentSummaryQuery extends StatsQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface CompanyDetailQuery {
  from?: string;
  to?: string;
  origin?: string;
  destination?: string;
  granularity?: 'day' | 'hour';
  limit?: number;
}

/** Maps UI traffic presets / granularity to a $dateToString format. */
const GRANULARITY_FORMAT: Record<Granularity, string> = {
  minute: '%Y-%m-%dT%H:%M',
  hour: '%Y-%m-%dT%H:00',
  day: '%Y-%m-%d',
};

/** Escape user input before using it in a MongoDB $regex (ReDoS-safe). */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(
    @InjectQueue(constant.QUEUES.TRACKER) private readonly trackerQueue: Queue,
    @InjectModel(Tracker.name)
    private readonly trackerModel: Model<TrackerDocument>,
    @InjectModel(CompanySummary.name)
    private readonly companySummaryModel: Model<CompanySummaryDocument>,
    @InjectModel(HourlyCompanyStats.name)
    private readonly hourlyStatsModel: Model<HourlyCompanyStatsDocument>,
  ) {}

  /** Truncate a date to the start of its UTC hour (the cube bucket key). */
  private static toHourBucket(d: Date): Date {
    const b = new Date(d);
    b.setUTCMinutes(0, 0, 0);
    return b;
  }

  /**
   * MongoDB forbids '.' and '$' in stored field names, and we use the
   * raw value as a map key (endpoints.<key>, countries.<key>). Endpoint
   * paths normally only contain '/', but be defensive: replace the two
   * illegal chars so a stray value can never break the $inc path.
   */
  private static safeKey(v: string | undefined | null): string {
    return (v && v.length ? v : 'unknown').replace(/[.$]/g, '_');
  }

  /** Enqueue an api-hit for async geo-enrichment + persistence. */
  async enqueue(dto: CreateTrackerDto): Promise<{ jobId: string }> {
    const job = await this.trackerQueue.add(
      constant.JOBS.PERSIST_TRACKER,
      dto,
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return { jobId: String(job.id) };
  }

  /** Persist a (geo-enriched) tracker record. Called by the processor. */
  async persist(
    data: CreateTrackerDto & Partial<Tracker>,
  ): Promise<TrackerDocument> {
    const doc = await this.trackerModel.create(data);
    await this.bumpCompanySummary(doc);
    await this.bumpHourlyStats(doc);
    return doc;
  }

  /**
   * Fold one hit into its (company, hour) cube bucket — the structure
   * that serves every date-filtered dashboard aggregation. One atomic
   * upsert: flat totals via $inc, the endpoint/status/country breakdowns
   * via $inc on dotted map paths, firstHit/lastHit via $min/$max.
   *
   * Best-effort, same rationale as bumpCompanySummary: the raw row is the
   * source of truth and the backfill recomputes the cube from it, so a
   * transient failure here is logged, not fatal.
   */
  private async bumpHourlyStats(doc: TrackerDocument): Promise<void> {
    const createdAt =
      (doc as { createdAt?: Date }).createdAt ?? new Date();
    const bucketHour = TrackerService.toHourBucket(createdAt);
    const hasRt = typeof doc.responseTimeMs === 'number';
    const rt = hasRt ? doc.responseTimeMs! : 0;

    const epKey = TrackerService.safeKey(doc.endpoint);
    const statusKey =
      typeof doc.statusCode === 'number'
        ? `${Math.floor(doc.statusCode / 100)}xx`
        : 'unknown';
    const ccKey = TrackerService.safeKey(doc.countryCode);

    const inc: Record<string, number> = {
      totalHits: 1,
      successCount: doc.success === true ? 1 : 0,
      errorCount: doc.success === false ? 1 : 0,
      blockedCount: doc.isBlocked === true ? 1 : 0,
      totalResponseTimeMs: rt,
      responseTimeSamples: hasRt ? 1 : 0,
      [`endpoints.${epKey}.hits`]: 1,
      [`endpoints.${epKey}.successCount`]: doc.success === true ? 1 : 0,
      [`endpoints.${epKey}.totalResponseTimeMs`]: rt,
      [`statusBuckets.${statusKey}`]: 1,
    };
    // Only record a country breakdown when the hit actually has one,
    // so hitsByCountry isn't polluted with an "unknown" bucket.
    if (doc.countryCode) {
      inc[`countries.${ccKey}.hits`] = 1;
    }

    try {
      await this.hourlyStatsModel.updateOne(
        { companyCode: doc.companyCode, bucketHour },
        {
          $inc: inc,
          $min: { firstHit: createdAt },
          $max: { lastHit: createdAt },
          // Store the display label for the country once; harmless to
          // re-set on every hit (same value), avoids a second write path.
          ...(doc.countryCode
            ? { $set: { [`countries.${ccKey}.country`]: doc.country ?? '' } }
            : {}),
        },
        { upsert: true },
      );
    } catch (err) {
      this.logger.error(
        `HourlyCompanyStats rollup failed for ${doc.companyCode} ` +
          `@${bucketHour.toISOString()} (hit ${String(doc._id)}): ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Atomically fold one persisted hit into its company's rollup so the
   * dashboard never has to $group over the raw collection. A single
   * upsert with $inc/$min/$max — no read-modify-write, so concurrent
   * worker writes (TRACKER_QUEUE_CONCURRENCY) can't lose updates.
   *
   * Best-effort: a rollup failure must not fail the hit itself (the raw
   * row is already written and is the source of truth). It's logged so a
   * drift can be detected and backfilled.
   */
  private async bumpCompanySummary(doc: TrackerDocument): Promise<void> {
    const hasResponseTime = typeof doc.responseTimeMs === 'number';
    // createdAt comes from Mongoose `timestamps: true`, not the Tracker
    // class, so it isn't on the static type — read it off the document.
    const createdAt = (doc as { createdAt?: Date }).createdAt ?? new Date();
    try {
      await this.companySummaryModel.updateOne(
        { companyCode: doc.companyCode },
        {
          $inc: {
            totalHits: 1,
            successCount: doc.success === true ? 1 : 0,
            errorCount: doc.success === false ? 1 : 0,
            totalResponseTimeMs: hasResponseTime ? doc.responseTimeMs! : 0,
            responseTimeSamples: hasResponseTime ? 1 : 0,
          },
          $min: { firstHit: createdAt },
          $max: { lastHit: createdAt },
        },
        { upsert: true },
      );
    } catch (err) {
      this.logger.error(
        `CompanySummary rollup failed for ${doc.companyCode} ` +
          `(hit ${String(doc._id)}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Distinct company codes — powers the dashboard's "Company Code"
   * dropdown. Reads the rollup collection (one doc per company, a few
   * hundred at most) instead of running distinct() over the millions of
   * raw hit rows, which was a full index scan on every dropdown load.
   */
  async listCompanyCodes(): Promise<string[]> {
    const rows = await this.companySummaryModel
      .find({}, { companyCode: 1, _id: 0 })
      .sort({ companyCode: 1 })
      .lean()
      .exec();
    return rows.map((r) => r.companyCode).filter(Boolean);
  }

  async findRecent(q: StatsQuery & { limit?: number }): Promise<Tracker[]> {
    // Reuses buildMatch so companyCode + from/to behave identically to the
    // stats endpoints (the Recent table now honours the date range too).
    return this.trackerModel
      .find(this.buildMatch(q))
      .sort({ createdAt: -1 })
      .limit(Math.min(q.limit ?? 50, 200))
      .lean()
      .exec();
  }

  /**
   * "Recent API Hit Summary" table — one row PER COMPANY PER DAY,
   * matching the UI columns: Total Hits, Avg Hits/Sec, Success Rate,
   * Error Rate, Avg Response Time, Date (the calendar day, UTC). Newest
   * day first. Supports the companyCode + date filters, the table
   * "Search" box (companyCode prefix, case-insensitive) and server-side
   * pagination over the company-day rows.
   */
  async recentSummary(q: RecentSummaryQuery) {
    // Served from the hourly cube: buckets matched by the range are
    // collapsed to (company, day). Metrics are TRUE DATE-RANGE metrics —
    // a from/to filter scopes which days/hours are included (hour-precise,
    // see buildCubeMatch). Still fast: groups at most
    // (hours-in-range x companies) small cube docs, never the raw rows.
    const match = this.buildCubeMatch(q);
    if (q.search) {
      match.companyCode = {
        $regex: `^${escapeRegex(q.search)}`,
        $options: 'i',
      };
    }

    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(Math.max(1, q.pageSize ?? 10), 100);

    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        // One row PER COMPANY PER DAY: the hourly cube buckets are
        // collapsed to the calendar day (UTC) they fall in, so the
        // table shows daily activity per company instead of a single
        // all-time total per company.
        $group: {
          _id: {
            companyCode: '$companyCode',
            day: {
              $dateTrunc: { date: '$bucketHour', unit: 'day' },
            },
          },
          totalHits: { $sum: '$totalHits' },
          successCount: { $sum: '$successCount' },
          errorCount: { $sum: '$errorCount' },
          totalResponseTimeMs: { $sum: '$totalResponseTimeMs' },
          responseTimeSamples: { $sum: '$responseTimeSamples' },
          firstHit: { $min: '$firstHit' },
          lastHit: { $max: '$lastHit' },
        },
      },
      {
        $project: {
          _id: 0,
          companyCode: '$_id.companyCode',
          totalHits: 1,
          avgHitsPerSec: {
            $let: {
              vars: {
                spanSec: {
                  $divide: [
                    { $subtract: ['$lastHit', '$firstHit'] },
                    1000,
                  ],
                },
              },
              in: {
                $cond: [
                  { $gt: ['$$spanSec', 0] },
                  { $divide: ['$totalHits', '$$spanSec'] },
                  0,
                ],
              },
            },
          },
          successRate: {
            $cond: [
              { $gt: ['$totalHits', 0] },
              {
                $multiply: [
                  { $divide: ['$successCount', '$totalHits'] },
                  100,
                ],
              },
              0,
            ],
          },
          errorRate: {
            $cond: [
              { $gt: ['$totalHits', 0] },
              {
                $multiply: [
                  { $divide: ['$errorCount', '$totalHits'] },
                  100,
                ],
              },
              0,
            ],
          },
          avgResponseTimeMs: {
            $cond: [
              { $gt: ['$responseTimeSamples', 0] },
              {
                $round: [
                  {
                    $divide: [
                      '$totalResponseTimeMs',
                      '$responseTimeSamples',
                    ],
                  },
                  0,
                ],
              },
              0,
            ],
          },
          // The calendar day this row aggregates (what the DATE column
          // renders), not the last-hit timestamp.
          date: '$_id.day',
        },
      },
      // Newest day first; companyCode as a stable tiebreaker so rows on
      // the same day have a deterministic order across pages.
      { $sort: { date: -1, companyCode: 1 } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [res] = await this.hourlyStatsModel.aggregate(pipeline);
    const total = res?.total?.[0]?.count ?? 0;
    return {
      data: res?.data ?? [],
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Company-detail view: per-route (origin→destination) hit breakdown
   * for ONE company, plus KPI summary and a daily/hourly time-series
   * for charting.
   *
   * Served from raw `trackers` (origin/destination aren't in the hourly
   * cube). The {companyCode, createdAt} compound index covers the match;
   * the date range bounds the scan. One $facet pipeline returns all three
   * branches in a single round trip.
   *
   * Hits without origin OR destination (non-search traffic) are excluded
   * from the route/series breakdowns so the chart isn't polluted with an
   * "unknown→unknown" stack; they still count toward `summary` totals.
   */
  async companyDetail(companyCode: string, q: CompanyDetailQuery) {
    const match: FilterQuery<TrackerDocument> = { companyCode };
    if (q.from || q.to) {
      match.createdAt = {};
      if (q.from)
        (match.createdAt as Record<string, Date>).$gte = new Date(q.from);
      if (q.to)
        (match.createdAt as Record<string, Date>).$lte = new Date(q.to);
    }
    if (q.origin) match.origin = q.origin;
    if (q.destination) match.destination = q.destination;

    const granularity: 'day' | 'hour' = q.granularity === 'hour' ? 'hour' : 'day';
    const limit = Math.min(Math.max(1, q.limit ?? 20), 100);

    // Only rows with BOTH origin and destination feed the route/series
    // breakdowns. The summary branch sees the full match (all traffic).
    const routeMatch: FilterQuery<TrackerDocument> = {
      origin: { $exists: true, $ne: '' },
      destination: { $exists: true, $ne: '' },
    };

    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalHits: { $sum: 1 },
                successCount: {
                  $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] },
                },
                errorCount: {
                  $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] },
                },
                totalResponseTimeMs: {
                  $sum: {
                    $cond: [
                      { $isNumber: '$responseTimeMs' },
                      '$responseTimeMs',
                      0,
                    ],
                  },
                },
                responseTimeSamples: {
                  $sum: {
                    $cond: [{ $isNumber: '$responseTimeMs' }, 1, 0],
                  },
                },
                firstHit: { $min: '$createdAt' },
                lastHit: { $max: '$createdAt' },
              },
            },
          ],
          routes: [
            { $match: routeMatch },
            // Stage 1: per-(route, day) counts. Day granularity is used
            // for the `dates` array regardless of `granularity` (which
            // only controls the top-level `series` bucket size).
            {
              $group: {
                _id: {
                  origin: '$origin',
                  destination: '$destination',
                  day: {
                    $dateTrunc: { date: '$createdAt', unit: 'day' },
                  },
                },
                dayHits: { $sum: 1 },
                daySuccess: {
                  $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] },
                },
                dayResponseTimeMs: {
                  $sum: {
                    $cond: [
                      { $isNumber: '$responseTimeMs' },
                      '$responseTimeMs',
                      0,
                    ],
                  },
                },
                dayResponseSamples: {
                  $sum: {
                    $cond: [{ $isNumber: '$responseTimeMs' }, 1, 0],
                  },
                },
              },
            },
            // Sort day rows desc so $push preserves latest-first order
            // when collapsing to the route level.
            { $sort: { '_id.day': -1 } },
            // Stage 2: collapse to the route level, carrying the per-day
            // breakdown along as `dates` (already latest-first).
            {
              $group: {
                _id: {
                  origin: '$_id.origin',
                  destination: '$_id.destination',
                },
                hits: { $sum: '$dayHits' },
                successCount: { $sum: '$daySuccess' },
                totalResponseTimeMs: { $sum: '$dayResponseTimeMs' },
                responseTimeSamples: { $sum: '$dayResponseSamples' },
                dates: {
                  $push: {
                    date: '$_id.day',
                    hits: '$dayHits',
                    successRate: {
                      $cond: [
                        { $gt: ['$dayHits', 0] },
                        {
                          $multiply: [
                            { $divide: ['$daySuccess', '$dayHits'] },
                            100,
                          ],
                        },
                        0,
                      ],
                    },
                    avgResponseTimeMs: {
                      $cond: [
                        { $gt: ['$dayResponseSamples', 0] },
                        {
                          $round: [
                            {
                              $divide: [
                                '$dayResponseTimeMs',
                                '$dayResponseSamples',
                              ],
                            },
                            0,
                          ],
                        },
                        0,
                      ],
                    },
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                origin: '$_id.origin',
                destination: '$_id.destination',
                hits: 1,
                dates: 1,
                successRate: {
                  $cond: [
                    { $gt: ['$hits', 0] },
                    {
                      $multiply: [
                        { $divide: ['$successCount', '$hits'] },
                        100,
                      ],
                    },
                    0,
                  ],
                },
                avgResponseTimeMs: {
                  $cond: [
                    { $gt: ['$responseTimeSamples', 0] },
                    {
                      $round: [
                        {
                          $divide: [
                            '$totalResponseTimeMs',
                            '$responseTimeSamples',
                          ],
                        },
                        0,
                      ],
                    },
                    0,
                  ],
                },
              },
            },
            { $sort: { hits: -1 } },
            { $limit: limit },
          ],
          // Total distinct (origin, destination) pairs across the range —
          // independent of `limit`, which only caps the routes list.
          distinctRoutes: [
            { $match: routeMatch },
            {
              $group: {
                _id: { origin: '$origin', destination: '$destination' },
              },
            },
            { $count: 'count' },
          ],
          series: [
            { $match: routeMatch },
            {
              $group: {
                _id: {
                  date: {
                    $dateTrunc: { date: '$createdAt', unit: granularity },
                  },
                  origin: '$origin',
                  destination: '$destination',
                },
                hits: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                date: '$_id.date',
                origin: '$_id.origin',
                destination: '$_id.destination',
                hits: 1,
              },
            },
            { $sort: { date: 1 } },
          ],
        },
      },
    ];

    const [res] = await this.trackerModel.aggregate(pipeline);
    const s = res?.summary?.[0];
    const routes = res?.routes ?? [];
    const totalHits = s?.totalHits ?? 0;
    const samples = s?.responseTimeSamples ?? 0;

    return {
      companyCode,
      range: { from: q.from ?? null, to: q.to ?? null, granularity },
      summary: {
        totalHits,
        successRate: totalHits ? (s.successCount / totalHits) * 100 : 0,
        errorRate: totalHits ? (s.errorCount / totalHits) * 100 : 0,
        avgResponseTimeMs: samples
          ? Math.round(s.totalResponseTimeMs / samples)
          : 0,
        distinctRoutes: res?.distinctRoutes?.[0]?.count ?? 0,
        topRoute: routes[0]
          ? {
              origin: routes[0].origin,
              destination: routes[0].destination,
              hits: routes[0].hits,
            }
          : null,
        firstHit: s?.firstHit ?? null,
        lastHit: s?.lastHit ?? null,
      },
      routes,
      series: res?.series ?? [],
    };
  }

  // ---------- dashboard aggregations ----------

  private buildMatch(q: StatsQuery): FilterQuery<TrackerDocument> {
    const match: FilterQuery<TrackerDocument> = {};
    if (q.companyCode) match.companyCode = q.companyCode;
    if (q.from || q.to) {
      match.createdAt = {};
      if (q.from) (match.createdAt as Record<string, Date>).$gte = new Date(q.from);
      if (q.to) (match.createdAt as Record<string, Date>).$lte = new Date(q.to);
    }
    return match;
  }

  /**
   * $match for the hourly cube. Same companyCode + from/to contract as
   * buildMatch, but the date range applies to `bucketHour`.
   *
   * RANGE PRECISION: the cube is hour-grained, so a hit at 14:37 lives in
   * the 14:00 bucket. We floor `from` and ceil `to` to hour boundaries so
   * a partial edge hour is included rather than silently dropped. Net
   * effect: date filtering is accurate to the hour (an edge query can
   * include up to ~59min of adjacent data). This is the deliberate
   * tradeoff for serving any-range queries off rollups instead of a
   * ~1M-row scan; pass hour-aligned from/to for exact totals.
   */
  private buildCubeMatch(
    q: StatsQuery,
  ): FilterQuery<HourlyCompanyStatsDocument> {
    const match: FilterQuery<HourlyCompanyStatsDocument> = {};
    if (q.companyCode) match.companyCode = q.companyCode;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) {
        const f = new Date(q.from);
        f.setUTCMinutes(0, 0, 0);
        range.$gte = f;
      }
      if (q.to) {
        const t = new Date(q.to);
        // ceil to the end of the to-hour: next hour start, exclusive.
        t.setUTCMinutes(0, 0, 0);
        t.setUTCHours(t.getUTCHours() + 1);
        range.$lt = t;
      }
      match.bucketHour = range;
    }
    return match;
  }

  /**
   * Top cards: total hits, success/error rate, avg response time, blocked.
   * Served from the hourly cube — sums the flat per-bucket totals instead
   * of scanning raw hits. avgResponseTimeMs is recovered exactly from the
   * stored sum/sample-count (not a $avg of per-bucket averages, which
   * would be wrong since buckets have unequal hit counts).
   */
  async summary(q: StatsQuery) {
    const [row] = await this.hourlyStatsModel.aggregate([
      { $match: this.buildCubeMatch(q) },
      {
        $group: {
          _id: null,
          totalHits: { $sum: '$totalHits' },
          successCount: { $sum: '$successCount' },
          errorCount: { $sum: '$errorCount' },
          blockedCount: { $sum: '$blockedCount' },
          totalResponseTimeMs: { $sum: '$totalResponseTimeMs' },
          responseTimeSamples: { $sum: '$responseTimeSamples' },
        },
      },
    ]);

    const totalHits = row?.totalHits ?? 0;
    const samples = row?.responseTimeSamples ?? 0;
    return {
      totalHits,
      successRate: totalHits ? (row.successCount / totalHits) * 100 : 0,
      errorRate: totalHits ? (row.errorCount / totalHits) * 100 : 0,
      blockedRequests: row?.blockedCount ?? 0,
      avgResponseTimeMs: samples
        ? Math.round(row.totalResponseTimeMs / samples)
        : 0,
    };
  }

  /**
   * "Top API Endpoints" table. Served from the cube's per-bucket
   * `endpoints` map: $objectToArray turns { "/search": {...} } into rows,
   * then we re-sum each endpoint's per-bucket sub-totals across the range.
   */
  async topEndpoints(q: StatsQuery, limit = 10) {
    return this.hourlyStatsModel.aggregate([
      { $match: this.buildCubeMatch(q) },
      { $project: { kv: { $objectToArray: '$endpoints' } } },
      { $unwind: '$kv' },
      {
        $group: {
          _id: '$kv.k',
          hits: { $sum: '$kv.v.hits' },
          successCount: { $sum: '$kv.v.successCount' },
          totalResponseTimeMs: { $sum: '$kv.v.totalResponseTimeMs' },
        },
      },
      {
        $project: {
          _id: 0,
          endpoint: '$_id',
          hits: 1,
          avgResponseTimeMs: {
            $cond: [
              { $gt: ['$hits', 0] },
              { $round: [{ $divide: ['$totalResponseTimeMs', '$hits'] }, 0] },
              0,
            ],
          },
          successRate: {
            $cond: [
              { $gt: ['$hits', 0] },
              {
                $multiply: [
                  { $divide: ['$successCount', '$hits'] },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      { $sort: { hits: -1 } },
      { $limit: limit },
    ]);
  }

  /**
   * "Status Code Distribution" donut. Served from the cube's
   * `statusBuckets` map ({ "2xx": n, ... }) summed across the range.
   */
  async statusDistribution(q: StatsQuery) {
    return this.hourlyStatsModel.aggregate([
      { $match: this.buildCubeMatch(q) },
      { $project: { kv: { $objectToArray: '$statusBuckets' } } },
      { $unwind: '$kv' },
      { $group: { _id: '$kv.k', count: { $sum: '$kv.v' } } },
      { $project: { _id: 0, group: '$_id', count: 1 } },
      { $sort: { group: 1 } },
    ]);
  }

  /**
   * "Hits by Country" / Geography. Served from the cube's `countries`
   * map (keyed by countryCode, with the display `country` stored inside).
   * Hits without geo are never written into the map, so no null filter
   * is needed.
   */
  async hitsByCountry(q: StatsQuery, limit = 10) {
    return this.hourlyStatsModel.aggregate([
      { $match: this.buildCubeMatch(q) },
      { $project: { kv: { $objectToArray: '$countries' } } },
      { $unwind: '$kv' },
      {
        $group: {
          _id: '$kv.k',
          hits: { $sum: '$kv.v.hits' },
          // labels are identical per countryCode; $last picks one.
          country: { $last: '$kv.v.country' },
        },
      },
      {
        $project: {
          _id: 0,
          countryCode: '$_id',
          country: 1,
          hits: 1,
        },
      },
      { $sort: { hits: -1 } },
      { $limit: limit },
    ]);
  }

  /**
   * "Traffic Over Time" — hits bucketed at the requested granularity,
   * served from the hourly cube by re-bucketing `bucketHour`.
   *
   * GRANULARITY: 'hour' and 'day' are exact (the cube's native grain or
   * coarser). 'minute' CANNOT be served from an hourly cube — the finest
   * stored resolution is the hour — so a 'minute' request is answered at
   * hour grain. (Per-minute rollups would 60x the cube; the per-hour
   * grain was chosen deliberately. For true minute resolution on a small
   * recent window, query the raw collection instead.) Invalid values
   * fall back to hour.
   */
  async trafficOverTime(q: StatsQuery, granularity: Granularity = 'hour') {
    const effective: Granularity =
      granularity === 'minute' ? 'hour' : granularity;
    const format =
      GRANULARITY_FORMAT[effective] ?? GRANULARITY_FORMAT.hour;
    return this.hourlyStatsModel.aggregate([
      { $match: this.buildCubeMatch(q) },
      {
        $group: {
          _id: {
            $dateToString: {
              format,
              date: '$bucketHour',
              timezone: 'UTC',
            },
          },
          hits: { $sum: '$totalHits' },
        },
      },
      { $project: { _id: 0, bucket: '$_id', hits: 1 } },
      { $sort: { bucket: 1 } },
    ]);
  }
}
