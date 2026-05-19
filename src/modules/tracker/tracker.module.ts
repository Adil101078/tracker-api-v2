import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import constant from '@core/constants';
import { TrackingInterceptor } from '@core/interceptors/tracking.interceptor';
import { TrackerController } from './tracker.controller';
import { AdminReportController } from './admin-report.controller';
import { TrackerProcessor } from './tracker.processor';
import { TrackerService } from './tracker.service';
import { Tracker, TrackerSchema } from './schemas/tracker.schema';
import {
  CompanySummary,
  CompanySummarySchema,
} from './schemas/company-summary.schema';
import {
  HourlyCompanyStats,
  HourlyCompanyStatsSchema,
} from './schemas/hourly-company-stats.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tracker.name, schema: TrackerSchema },
      { name: CompanySummary.name, schema: CompanySummarySchema },
      {
        name: HourlyCompanyStats.name,
        schema: HourlyCompanyStatsSchema,
      },
    ]),
    BullModule.registerQueue({ name: constant.QUEUES.TRACKER }),
  ],
  controllers: [TrackerController, AdminReportController],
  providers: [
    TrackerService,
    TrackerProcessor,
    { provide: APP_INTERCEPTOR, useClass: TrackingInterceptor },
  ],
  exports: [TrackerService],
})
export class TrackerModule {}
