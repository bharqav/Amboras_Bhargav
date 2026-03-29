import { Controller, Get, Logger, MessageEvent, Query, Req, Sse, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { exhaustMap, from, interval, map, Observable, startWith } from 'rxjs';
import { TenantGuard } from '../common/tenant.guard';
import { AnalyticsService } from './analytics.service';
import { ActivityFilterDto } from './dto/activity-filter.dto';
import { LiveVisitorsDto } from './dto/live-visitors.dto';
import { LimitDto } from './dto/pagination.dto';
import { TrendDto } from './dto/trend.dto';
import { DashboardStreamDto } from './dto/dashboard-stream.dto';

type TenantRequest = Request & { storeId?: string };

@Controller('analytics')
@UseGuards(TenantGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);
  private dashboardPollCount = 0;

  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  async getOverview(@Req() req: TenantRequest, @Query() query: LimitDto) {
    return this.analyticsService.getOverview(req.storeId as string, query.startDate, query.endDate);
  }

  @Get('top-products')
  async getTopProducts(@Req() req: TenantRequest, @Query() query: LimitDto) {
    return this.analyticsService.getTopProducts(req.storeId as string, query.limit ?? 10, query.startDate, query.endDate);
  }

  @Get('recent-activity')
  async getRecentActivity(@Req() req: TenantRequest, @Query() query: ActivityFilterDto) {
    return this.analyticsService.getRecentActivity(
      req.storeId as string,
      query.limit ?? 20,
      query.eventType,
      query.startDate,
      query.endDate,
    );
  }

  @Get('live-visitors')
  async getLiveVisitors(@Req() req: TenantRequest, @Query() query: LiveVisitorsDto) {
    return this.analyticsService.getLiveVisitors(req.storeId as string, query.minutes ?? 5);
  }

  @Get('sales-trend')
  async getSalesTrend(@Req() req: TenantRequest, @Query() query: TrendDto) {
    return this.analyticsService.getSalesTrend(
      req.storeId as string,
      query.interval ?? 'day',
      query.startDate,
      query.endDate,
    );
  }

  @Get('funnel')
  async getFunnel(@Req() req: TenantRequest, @Query() query: LimitDto) {
    return this.analyticsService.getFunnel(req.storeId as string, query.startDate, query.endDate);
  }

  /** One JSON round-trip for the whole dashboard (preferred for browsers: cookies + simple polling). */
  @Get('dashboard')
  async getDashboard(@Req() req: TenantRequest, @Query() query: LimitDto) {
    const storeId = req.storeId as string;
    const pollId = ++this.dashboardPollCount;
    const startedAt = Date.now();
    const rangeLabel = `${query.startDate ?? 'default'}..${query.endDate ?? 'default'}`;
    this.logger.log(`GET /analytics/dashboard start poll=#${pollId} store=${storeId} range=${rangeLabel}`);
    const snapshot = await this.analyticsService.getDashboardSnapshot(storeId, query.startDate, query.endDate, 0);
    this.logger.log(
      `GET /analytics/dashboard done poll=#${pollId} store=${storeId} range=${rangeLabel} ms=${Date.now() - startedAt}`,
    );
    return snapshot;
  }

  // Optional SSE stream (same payload shape as GET /dashboard). Prefer GET /dashboard + polling for reliability.
  @Sse('dashboard-stream')
  dashboardStream(@Req() req: TenantRequest, @Query() query: DashboardStreamDto): Observable<MessageEvent> {
    const storeId = req.storeId as string;
    return interval(2000).pipe(
      startWith(0),
      exhaustMap(() => from(this.analyticsService.getDashboardSnapshot(storeId, query.startDate, query.endDate, 1))),
      map((data) => ({ data })),
    );
  }
}
