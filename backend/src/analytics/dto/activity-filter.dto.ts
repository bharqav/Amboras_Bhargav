import { IsIn, IsOptional } from 'class-validator';
import { LimitDto } from './pagination.dto';

export class ActivityFilterDto extends LimitDto {
  @IsOptional()
  @IsIn(['page_view', 'add_to_cart', 'remove_from_cart', 'checkout_started', 'purchase'])
  eventType?: 'page_view' | 'add_to_cart' | 'remove_from_cart' | 'checkout_started' | 'purchase';
}
