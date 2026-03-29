import { IsOptional, IsString } from 'class-validator';
import { DateRangeDto } from './date-range.dto';

// SSE uses `EventSource`, which cannot set Authorization headers in the browser.
// We accept the JWT via query param and let `TenantGuard` verify it.
export class DashboardStreamDto extends DateRangeDto {
  @IsOptional()
  @IsString()
  accessToken?: string;
}

