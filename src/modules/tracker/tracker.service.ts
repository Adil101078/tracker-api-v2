import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { FilterQuery, Model, PipelineStage } from 'mongoose';
import constant from '@core/constants';
import { CreateTrackerDto } from './dto/create-tracker.dto';
import { Tracker, TrackerDocument } from './schemas/tracker.schema';

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
  ) {}

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
    return this.trackerModel.create(data);
  }

  /**
   * Distinct company codes — powers the dashboard's "Company Code"
   * dropdown. Served by the companyCode-leading compound indexes
   * (covered query, fast even at millions of rows).
   */
  async listCompanyCodes(): Promise<string[]> {
    const codes: string[] = await this.trackerModel.distinct('companyCode');
    return codes.filter(Boolean).sort();
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
   * "Recent API Hit Summary" table — one row PER COMPANY (not per hit),
   * matching the UI columns: Total Hits, Avg Hits/Sec, Success Rate,
   * Error Rate, Avg Response Time, Date (last hit). Supports the
   * companyCode + date filters, the table "Search" box (companyCode
   * prefix, case-insensitive) and server-side pagination.
   */
  async recentSummary(q: RecentSummaryQuery) {
    const match = this.buildMatch(q);
    if (q.search) {
      match.companyCode = { $regex: `^${escapeRegex(q.search)}`, $options: 'i' };
    }

    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(Math.max(1, q.pageSize ?? 10), 100);

    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: '$companyCode',
          totalHits: { $sum: 1 },
          successCount: { $sum: { $cond: ['$success', 1, 0] } },
          errorCount: {
            $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] },
          },
          avgResponseTimeMs: { $avg: '$responseTimeMs' },
          firstHit: { $min: '$createdAt' },
          lastHit: { $max: '$createdAt' },
        },
      },
      {
        $project: {
          _id: 0,
          companyCode: '$_id',
          totalHits: 1,
          // hits / span-in-seconds; guard against a single-hit (0s) span.
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
            $multiply: [{ $divide: ['$successCount', '$totalHits'] }, 100],
          },
          errorRate: {
            $multiply: [{ $divide: ['$errorCount', '$totalHits'] }, 100],
          },
          avgResponseTimeMs: { $round: ['$avgResponseTimeMs', 0] },
          date: '$lastHit',
        },
      },
      { $sort: { date: -1 } },
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

    const [res] = await this.trackerModel.aggregate(pipeline);
    const total = res?.total?.[0]?.count ?? 0;
    return {
      data: res?.data ?? [],
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
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

  /** Top cards: total hits, success/error rate, avg response time, blocked. */
  async summary(q: StatsQuery) {
    const match = this.buildMatch(q);
    const [row] = await this.trackerModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalHits: { $sum: 1 },
          successCount: { $sum: { $cond: ['$success', 1, 0] } },
          errorCount: {
            $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] },
          },
          blockedCount: { $sum: { $cond: ['$isBlocked', 1, 0] } },
          avgResponseTimeMs: { $avg: '$responseTimeMs' },
        },
      },
    ]);

    const totalHits = row?.totalHits ?? 0;
    return {
      totalHits,
      successRate: totalHits ? (row.successCount / totalHits) * 100 : 0,
      errorRate: totalHits ? (row.errorCount / totalHits) * 100 : 0,
      blockedRequests: row?.blockedCount ?? 0,
      avgResponseTimeMs: Math.round(row?.avgResponseTimeMs ?? 0),
    };
  }

  /** "Top API Endpoints" table. */
  async topEndpoints(q: StatsQuery, limit = 10) {
    return this.trackerModel.aggregate([
      { $match: this.buildMatch(q) },
      {
        $group: {
          _id: '$endpoint',
          hits: { $sum: 1 },
          avgResponseTimeMs: { $avg: '$responseTimeMs' },
          successCount: { $sum: { $cond: ['$success', 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          endpoint: '$_id',
          hits: 1,
          avgResponseTimeMs: { $round: ['$avgResponseTimeMs', 0] },
          successRate: {
            $multiply: [{ $divide: ['$successCount', '$hits'] }, 100],
          },
        },
      },
      { $sort: { hits: -1 } },
      { $limit: limit },
    ]);
  }

  /** "Status Code Distribution" donut. */
  async statusDistribution(q: StatsQuery) {
    return this.trackerModel.aggregate([
      { $match: this.buildMatch(q) },
      {
        $group: {
          _id: {
            $concat: [
              { $toString: { $floor: { $divide: ['$statusCode', 100] } } },
              'xx',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, group: '$_id', count: 1 } },
      { $sort: { group: 1 } },
    ]);
  }

  /** "Hits by Country" / Geography. */
  async hitsByCountry(q: StatsQuery, limit = 10) {
    return this.trackerModel.aggregate([
      { $match: { ...this.buildMatch(q), country: { $ne: null } } },
      {
        $group: {
          _id: { country: '$country', countryCode: '$countryCode' },
          hits: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          country: '$_id.country',
          countryCode: '$_id.countryCode',
          hits: 1,
        },
      },
      { $sort: { hits: -1 } },
      { $limit: limit },
    ]);
  }

  /**
   * "Traffic Over Time" — hits bucketed at the requested granularity.
   * UI preset → granularity mapping (do this on the FE or pass directly):
   *   15m/1H → minute, 6H/24H/7D → hour, 30D/Custom → day.
   * Defaults to hour. Invalid values fall back to hour.
   */
  async trafficOverTime(q: StatsQuery, granularity: Granularity = 'hour') {
    const format =
      GRANULARITY_FORMAT[granularity] ?? GRANULARITY_FORMAT.hour;
    return this.trackerModel.aggregate([
      { $match: this.buildMatch(q) },
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          hits: { $sum: 1 },
        },
      },
      { $project: { _id: 0, bucket: '$_id', hits: 1 } },
      { $sort: { bucket: 1 } },
    ]);
  }
}
