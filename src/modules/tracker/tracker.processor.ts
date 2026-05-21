import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import constant from '@core/constants';
import getGeoData from '@core/utils/get-geo-data';
import { CreateTrackerDto } from './dto/create-tracker.dto';
import { TrackerService } from './tracker.service';

/**
 * BullMQ worker: enriches each api-hit with geolocation (resolved from
 * IP via ip-api.com) and writes it to MongoDB. Geo is best-effort —
 * a failed lookup never fails the job; the hit is still stored.
 */
@Processor(constant.QUEUES.TRACKER, {
  concurrency: Number(process.env.TRACKER_QUEUE_CONCURRENCY ?? 10),
})
export class TrackerProcessor extends WorkerHost {
  private readonly logger = new Logger(TrackerProcessor.name);

  constructor(private readonly trackerService: TrackerService) {
    super();
    // Diagnostic: log the resolved geo flag at startup so a stale build
    // or unread .env shows up immediately in the boot logs.
    this.logger.log(
      `GEO_LOOKUP_ENABLED=${process.env.GEO_LOOKUP_ENABLED ?? '<unset>'}`,
    );
  }

  async process(job: Job<CreateTrackerDto>): Promise<{ id: string }> {
    if (job.name !== constant.JOBS.PERSIST_TRACKER) {
      this.logger.warn(`Unknown job name: ${job.name}`);
      return { id: '' };
    }

    const data = { ...job.data };

    // Geo enrichment: gated at the CALL SITE so a stale build of
    // get-geo-data.ts can't bypass the flag. Off unless explicitly set.
    const geoEnabled = process.env.GEO_LOOKUP_ENABLED === 'true';
    if (geoEnabled && data.IP && !data.country) {
      const geo = await getGeoData(data.IP);
      if (geo) {
        data.country = geo.country;
        data.countryCode = geo.countryCode;
        data.region = geo.region;
        data.regionName = geo.regionName;
        data.city = geo.city;
        data.lat = geo.lat;
        data.lon = geo.lon;
        data.timezone = geo.timezone;
        data.isp = geo.isp;
        data.org = geo.org;
      }
    }

    const doc = await this.trackerService.persist(data);
    return { id: String(doc._id) };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
    );
  }
}
