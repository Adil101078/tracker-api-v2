import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common";
import { CreateTrackerDto } from "./dto/create-tracker.dto";

/**
 * Admin-facing report endpoint. With the global `api` prefix
 * (main.ts) plus this controller path, the full route is:
 *   POST /api/v1/admin/api-tracker/create-report
 *
 * Kept on its own controller (not TrackerController) so it doesn't
 * inherit the `tracker` controller prefix.
 *
 * Behaviour mirrors the old TrackerController.create acknowledgement:
 * the TrackingInterceptor records this request automatically (telemetry
 * + geo), so this handler must NOT enqueue again — doing so would create
 * a duplicate, telemetry-less row and skew every aggregation. The body
 * (companyCode, origin, ...) is still picked up by the interceptor.
 */
@Controller("v1/admin/api-tracker")
export class AdminReportController {
  private readonly logger = new Logger(AdminReportController.name);

  @Post("create-report")
  @HttpCode(HttpStatus.ACCEPTED)
  createReport(@Body() dto: CreateTrackerDto) {
    this.logger.log(
      `create-report: companyCode=${dto.companyCode} origin=${dto.origin ?? "-"} destination=${dto.destination ?? "-"}`,
    );
    return { success: true, message: "Tracker accepted for processing" };
  }
}
