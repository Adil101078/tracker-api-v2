import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import constant from '@core/constants';
import { TrackingInterceptor } from '@core/interceptors/tracking.interceptor';
import { TrackerController } from './tracker.controller';
import { TrackerProcessor } from './tracker.processor';
import { TrackerService } from './tracker.service';
import { Tracker, TrackerSchema } from './schemas/tracker.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tracker.name, schema: TrackerSchema },
    ]),
    BullModule.registerQueue({ name: constant.QUEUES.TRACKER }),
  ],
  controllers: [TrackerController],
  providers: [
    TrackerService,
    TrackerProcessor,
    { provide: APP_INTERCEPTOR, useClass: TrackingInterceptor },
  ],
  exports: [TrackerService],
})
export class TrackerModule {}
