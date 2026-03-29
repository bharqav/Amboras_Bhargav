import { IsIn, IsOptional } from 'class-validator';
import { DateRangeDto } from './date-range.dto';

export class TrendDto extends DateRangeDto {
  @IsOptional()
  @IsIn(['hour', 'day'])
  interval?: 'hour' | 'day';
}
