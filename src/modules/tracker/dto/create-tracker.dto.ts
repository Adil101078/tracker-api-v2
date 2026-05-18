import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Payload accepted by POST /tracker and produced internally by the
 * TrackingInterceptor. companyCode is the only required field
 * (matches the schema). Telemetry/geo fields are optional — geo is
 * filled in by the worker, telemetry by the interceptor.
 */
export class CreateTrackerDto {
  @IsString()
  companyCode: string;

  @IsOptional() @IsString() credentialCode?: string;
  @IsOptional() @IsString() secretKey?: string;
  @IsOptional() @IsString() referralUrl?: string;
  @IsOptional() @IsString() searchId?: string;
  @IsOptional() @IsString() origin?: string;
  @IsOptional() @IsString() destination?: string;
  @IsOptional() @IsString() classOfService?: string;
  @IsOptional() @IsString() adults?: string;
  @IsOptional() @IsString() child?: string;
  @IsOptional() @IsString() infants?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() departureDate?: string;
  @IsOptional() @IsString() returnDate?: string;

  // ---- telemetry (set by interceptor) ----
  @IsOptional() @IsString() endpoint?: string;
  @IsOptional() @IsString() httpMethod?: string;
  @IsOptional() @IsInt() statusCode?: number;
  @IsOptional() @IsBoolean() success?: boolean;
  @IsOptional() @IsNumber() responseTimeMs?: number;
  @IsOptional() @IsString() userAgent?: string;
  @IsOptional() @IsBoolean() isBot?: boolean;
  @IsOptional() @IsBoolean() isBlocked?: boolean;

  // ---- network / geo (IP from interceptor, rest from worker) ----
  @IsOptional() @IsString() IP?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() countryCode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() regionName?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lon?: number;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() isp?: string;
  @IsOptional() @IsString() org?: string;
}
