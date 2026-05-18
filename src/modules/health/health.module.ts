import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import constant from '@core/constants';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  // Re-register the queue here so HealthService can inject it to ping
  // Redis / the message queue. (registerQueue is idempotent per name.)
  imports: [BullModule.registerQueue({ name: constant.QUEUES.TRACKER })],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
