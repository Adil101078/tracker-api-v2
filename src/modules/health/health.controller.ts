import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { SkipTracking } from '@core/decorators/skip-tracking.decorator';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Powers the dashboard's "System Health" panel.
   * Always returns 200 with the report (degraded != HTTP error) so the
   * panel can render per-component status; the FE reads `overall`.
   * @SkipTracking so health polling doesn't pollute api-hit data.
   */
  @Get()
  @SkipTracking()
  @HttpCode(HttpStatus.OK)
  get() {
    return this.healthService.getReport();
  }
}
