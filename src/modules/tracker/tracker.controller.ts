import { Controller, Get, Query } from "@nestjs/common";
import { SkipTracking } from "@core/decorators/skip-tracking.decorator";
import {
  Granularity,
  RecentSummaryQuery,
  StatsQuery,
  TrackerService,
} from "./tracker.service";

@Controller("tracker")
export class TrackerController {
  constructor(private readonly trackerService: TrackerService) {}

  /** Distinct company codes for the "Company Code" filter dropdown. */
  @Get("companies")
  @SkipTracking()
  async companies() {
    const data = await this.trackerService.listCompanyCodes();
    return { success: true, count: data.length, data };
  }

  @Get()
  @SkipTracking()
  async list(@Query() q: StatsQuery, @Query("limit") limit?: string) {
    const data = await this.trackerService.findRecent({
      ...q,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { success: true, count: data.length, data };
  }

  /**
   * "Recent API Hit Summary" table — per-company aggregated rows.
   * Supports companyCode + from/to filters, the table search box and
   * server-side pagination (page / pageSize).
   */
  @Get("stats/recent-summary")
  @SkipTracking()
  recentSummary(@Query() q: RecentSummaryQuery) {
    return this.trackerService.recentSummary({
      ...q,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 10,
    });
  }

  // ---------- dashboard endpoints (not self-tracked) ----------

  @Get("stats/summary")
  @SkipTracking()
  summary(@Query() q: StatsQuery) {
    return this.trackerService.summary(q);
  }

  @Get("stats/top-endpoints")
  @SkipTracking()
  topEndpoints(@Query() q: StatsQuery, @Query("limit") limit?: string) {
    return this.trackerService.topEndpoints(
      q,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get("stats/status-distribution")
  @SkipTracking()
  statusDistribution(@Query() q: StatsQuery) {
    return this.trackerService.statusDistribution(q);
  }

  @Get("stats/hits-by-country")
  @SkipTracking()
  hitsByCountry(@Query() q: StatsQuery, @Query("limit") limit?: string) {
    return this.trackerService.hitsByCountry(
      q,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get("stats/traffic-over-time")
  @SkipTracking()
  trafficOverTime(
    @Query() q: StatsQuery,
    @Query("granularity") granularity?: Granularity,
  ) {
    return this.trackerService.trafficOverTime(q, granularity ?? "hour");
  }
}
