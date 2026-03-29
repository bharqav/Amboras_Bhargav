import { Inject, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Pool, type PoolClient } from 'pg';
import { PG_POOL, REDIS_CLIENT } from '../common/database.module';

type EventType = 'page_view' | 'add_to_cart' | 'remove_from_cart' | 'checkout_started' | 'purchase';

/** Coerce independent event counts into a non-inverting journey for charts (PV ≥ ATC ≥ CO ≥ RM ≥ PUR). */
function normalizeFunnelJourneyCounts(raw: {
  page_view: number | string;
  add_to_cart: number | string;
  checkout_started: number | string;
  remove_from_cart: number | string;
  purchase: number | string;
}): Record<EventType, number> {
  const pv = Math.max(0, Math.floor(Number(raw.page_view)));
  let atc = Math.max(0, Math.floor(Number(raw.add_to_cart)));
  let co = Math.max(0, Math.floor(Number(raw.checkout_started)));
  let rm = Math.max(0, Math.floor(Number(raw.remove_from_cart)));
  let pur = Math.max(0, Math.floor(Number(raw.purchase)));
  atc = Math.min(atc, pv);
  co = Math.min(co, atc);
  rm = Math.min(rm, co);
  pur = Math.min(pur, rm);
  return {
    page_view: pv,
    add_to_cart: atc,
    checkout_started: co,
    remove_from_cart: rm,
    purchase: pur,
  };
}

const DISPLAY_NAMES_BY_PRODUCT_ID: Record<string, string> = Object.fromEntries(
  [
    'Linen throw blanket',
    'Ceramic pour-over set',
    'Oak floating shelf',
    'LED desk lamp',
    'Wool runner rug',
    'Stainless kettle',
    'Bamboo utensil tray',
    'Cotton duvet cover',
    'Glass storage canisters',
    'Matte ceramic vase',
    'Brass cabinet pull set',
    'Recycled glass tumbler',
    'Teak bath mat',
    'Linen apron',
    'Cast iron skillet',
    'Marble coasters (set)',
    'Jute tote bag',
    'Hemp shower curtain',
    'Walnut cutting board',
    'Silicone baking mat',
    'Copper measuring cups',
    'Canvas storage bin',
    'Rattan pendant shade',
    'Stone soap dish',
    'Organic cotton towels',
  ].map((name, i) => [`prod_${String(i + 1).padStart(3, '0')}`, name]),
);

type TopProductRow = {
  product_id: string;
  revenue: number | string;
};

type RecentActivityRow = {
  event_id: string;
  store_id: string;
  event_type: string;
  timestamp: string;
  product_id: string | null;
  amount: number | string | null;
  currency: string | null;
};

type LiveVisitorsRow = {
  active_visitors: number | string;
};

type SalesTrendRow = {
  bucket: string;
  revenue: number | string;
  purchases: number | string;
};

type FunnelRow = {
  page_view: number | string;
  add_to_cart: number | string;
  checkout_started: number | string;
  remove_from_cart: number | string;
  purchase: number | string;
};

type AudienceMetrics = {
  /** Distinct sessions with at least one page_view in the selected window */
  uniqueVisitors: number;
  /** Distinct sessions with at least one purchase in the selected window */
  distinctPurchasers: number;
  /**
   * Distinct sessions that had add_to_cart in the window but no purchase event
   * in the same window (same store, same session_id).
   */
  sessionsWithCartNoPurchase: number;
};

/** Identifies calendar revenue windows in ANALYTICS_TIMEZONE; changes only at day / Mon / month boundaries. */
export type RevenuePeriodKeys = {
  today: string;
  week: string;
  month: string;
};

/**
 * One row: sums of purchase `amount` per calendar bucket in store timezone ($4).
 *
 * Model (same as “bucket starts at 0 at midnight”): for each window we use half-open
 * `[start, next_start)` in `timestamptz`. Any purchase in that interval adds its amount;
 * there is no separate counter—this query is the sum of those rows.
 *
 * Params: $1 store_id, $2/$3 dashboard range (selected period), $4 IANA timezone name.
 */
const REVENUE_BY_CALENDAR_BUCKETS_SQL = `
WITH cal AS (
  SELECT
    (date_trunc('day', now() AT TIME ZONE $4::text)) AT TIME ZONE $4::text AS day_start,
    (date_trunc('day', now() AT TIME ZONE $4::text) + interval '1 day') AT TIME ZONE $4::text AS day_end,
    (date_trunc('week', now() AT TIME ZONE $4::text)) AT TIME ZONE $4::text AS week_start,
    (date_trunc('week', now() AT TIME ZONE $4::text) + interval '1 week') AT TIME ZONE $4::text AS week_end,
    (date_trunc('month', now() AT TIME ZONE $4::text)) AT TIME ZONE $4::text AS month_start,
    (date_trunc('month', now() AT TIME ZONE $4::text) + interval '1 month') AT TIME ZONE $4::text AS month_end,
    to_char((now() AT TIME ZONE $4::text), 'YYYY-MM-DD') AS period_day_key,
    to_char(date_trunc('week', (now() AT TIME ZONE $4::text)), 'YYYY-MM-DD') AS period_week_key,
    to_char(date_trunc('month', (now() AT TIME ZONE $4::text)), 'YYYY-MM') AS period_month_key
)
SELECT
  COALESCE((
    SELECT SUM(e.amount)::float
    FROM analytics_events e
    WHERE e.store_id = $1
      AND e.event_type = 'purchase'
      AND e.timestamp >= cal.day_start
      AND e.timestamp < cal.day_end
  ), 0) AS revenue_today,
  COALESCE((
    SELECT SUM(e.amount)::float
    FROM analytics_events e
    WHERE e.store_id = $1
      AND e.event_type = 'purchase'
      AND e.timestamp >= cal.week_start
      AND e.timestamp < cal.week_end
  ), 0) AS revenue_week,
  COALESCE((
    SELECT SUM(e.amount)::float
    FROM analytics_events e
    WHERE e.store_id = $1
      AND e.event_type = 'purchase'
      AND e.timestamp >= cal.month_start
      AND e.timestamp < cal.month_end
  ), 0) AS revenue_month,
  COALESCE((
    SELECT SUM(e.amount)::float
    FROM analytics_events e
    WHERE e.store_id = $1
      AND e.event_type = 'purchase'
      AND e.timestamp >= $2::timestamptz
      AND e.timestamp <= $3::timestamptz
  ), 0) AS revenue_selected_range,
  cal.period_day_key,
  cal.period_week_key,
  cal.period_month_key
FROM cal
`;

type CalendarRevenueRow = {
  revenue_today: number | string;
  revenue_week: number | string;
  revenue_month: number | string;
  revenue_selected_range: number | string;
  period_day_key: string;
  period_week_key: string;
  period_month_key: string;
};

type DashboardSnapshot = {
  overview: {
    revenue: {
      today: number;
      thisWeek: number;
      thisMonth: number;
      selectedRange: number;
      periodKeys: RevenuePeriodKeys;
    };
    eventCounts: Record<EventType, number>;
    conversionRate: number;
    audience: AudienceMetrics;
  };
  topProducts: Array<{ product_id: string; name: string; revenue: number }>;
  recentActivity: Array<{
    eventId: string;
    storeId: string;
    eventType: string;
    timestamp: string;
    data: { productId: string | null; amount: number | null; currency: string | null };
  }>;
  liveVisitors: { activeVisitors: number; windowMinutes: number };
  salesTrend: Array<{ bucket: string; revenue: number; purchases: number }>;
  funnel: { steps: Array<{ stage: string; count: number; dropOffPct: number | null }> };
};

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly memoryCacheMaxEntries = Number(process.env.MEMORY_CACHE_MAX_ENTRIES ?? '500');
  private readonly memoryCache = new Map<string, { expiresAt: number; value: unknown }>();
  private dbFailureCooldownUntil = 0;
  private readonly syntheticState = new Map<
    string,
    {
      lastTickMs: number;
      carryRevenue: number;
      carryPurchases: number;
      totalRevenue: number;
      totalPurchases: number;
    }
  >();

  private getTierProfile(storeId: string): {
    liveVisitors: number;
    uniqueVisitors: number;
    distinctPurchasers: number;
    avgOrderValue: number;
  } {
    if (storeId === 'store_001') {
      return { liveVisitors: 98, uniqueVisitors: 1860, distinctPurchasers: 218, avgOrderValue: 79 };
    }
    if (storeId === 'store_002') {
      return { liveVisitors: 46, uniqueVisitors: 1020, distinctPurchasers: 112, avgOrderValue: 71 };
    }
    return { liveVisitors: 11, uniqueVisitors: 260, distinctPurchasers: 18, avgOrderValue: 58 };
  }

  private clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
  }

  private deterministicNoise(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  private forceSyntheticMode(): boolean {
    return this.config.get<string>('ANALYTICS_FORCE_SYNTHETIC', 'false').toLowerCase() === 'true';
  }

  private getSyntheticTick(
    storeId: string,
    avgOrderValue: number,
  ): {
    addRevenue: number;
    addPurchases: number;
    totalRevenue: number;
    totalPurchases: number;
  } {
    const now = Date.now();
    const prev = this.syntheticState.get(storeId) ?? {
      lastTickMs: now,
      carryRevenue: 0,
      carryPurchases: 0,
      totalRevenue: 0,
      totalPurchases: 0,
    };
    const elapsedSec = Math.max(1, Math.floor((now - prev.lastTickMs) / 1000));

    const targetPerMinute = storeId === 'store_001' ? 55 : storeId === 'store_002' ? 20 : 4;
    const basePurchases = (targetPerMinute / 60) * elapsedSec;
    const pulse = 0.85 + this.deterministicNoise(`${storeId}:${Math.floor(now / 2500)}`) * 0.45;
    const purchaseFloat = prev.carryPurchases + basePurchases * pulse;
    let addPurchases = Math.floor(purchaseFloat);
    if (elapsedSec >= 2 && addPurchases < 1) {
      addPurchases = 1;
    }

    const revenueFloat = prev.carryRevenue + addPurchases * avgOrderValue;
    const addRevenue = Math.max(1, Math.floor(revenueFloat));

    const totalRevenue = prev.totalRevenue + addRevenue;
    const totalPurchases = prev.totalPurchases + addPurchases;

    this.syntheticState.set(storeId, {
      lastTickMs: now,
      carryPurchases: Math.max(0, purchaseFloat - addPurchases),
      carryRevenue: Math.max(0, revenueFloat - addRevenue),
      totalRevenue,
      totalPurchases,
    });

    return { addRevenue, addPurchases, totalRevenue, totalPurchases };
  }

  private buildFallbackDashboardSnapshot(
    storeId: string,
    startDate?: string,
    endDate?: string,
  ): DashboardSnapshot {
    const now = new Date();
    const { start, end } = this.getWindow(startDate, endDate);
    const msPerDay = 24 * 60 * 60 * 1000;
    const selectedDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / msPerDay));
    const profile = this.getTierProfile(storeId);
    const todayPurchases = Math.max(1, Math.round(profile.distinctPurchasers * 0.85));
    const weekPurchases = Math.max(todayPurchases, Math.round(todayPurchases * 6.1));
    const monthPurchases = Math.max(weekPurchases, Math.round(todayPurchases * 28.8));
    const selectedRangePurchases = Math.max(1, Math.round((todayPurchases * selectedDays) / 1.35));

    const syntheticTick = this.getSyntheticTick(storeId, profile.avgOrderValue);

    const todayRevenue = Math.round(todayPurchases * profile.avgOrderValue) + syntheticTick.totalRevenue;
    const weekRevenue = Math.round(weekPurchases * profile.avgOrderValue) + syntheticTick.totalRevenue * 2;
    const monthRevenue = Math.round(monthPurchases * profile.avgOrderValue) + syntheticTick.totalRevenue * 4;
    const selectedRevenue =
      Math.round(selectedRangePurchases * profile.avgOrderValue) +
      syntheticTick.totalRevenue * Math.max(2, selectedDays);

    const noise = this.deterministicNoise(`${storeId}:${start.toISOString()}:${end.toISOString()}`);
    const uniqueVisitors = Math.max(1, Math.round(profile.uniqueVisitors * (0.95 + noise * 0.1)));
    const distinctPurchasers = this.clamp(
      Math.round(profile.distinctPurchasers * (0.95 + noise * 0.1)),
      1,
      uniqueVisitors,
    );
    const pageViews = Math.max(uniqueVisitors, Math.round(uniqueVisitors * (2.8 + noise * 0.5)));
    const addToCart = this.clamp(Math.round(pageViews * 0.28), 0, pageViews);
    const checkoutStarted = this.clamp(Math.round(addToCart * 0.62), 0, addToCart);
    const removeFromCart = this.clamp(Math.round(checkoutStarted * 0.41), 0, checkoutStarted);
    const purchase = this.clamp(
      Math.round(removeFromCart * 0.48) + syntheticTick.totalPurchases,
      0,
      removeFromCart,
    );

    const conversionRate = Number(((Math.min(distinctPurchasers, uniqueVisitors) / uniqueVisitors) * 100).toFixed(2));
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);

    const salesTrend: DashboardSnapshot['salesTrend'] = [];
    const points = Math.min(14, Math.max(7, selectedDays));
    for (let i = points - 1; i >= 0; i -= 1) {
      const bucketDate = new Date(now.getTime() - i * msPerDay);
      const bucketNoise = this.deterministicNoise(`${storeId}:bucket:${i}`);
      const bucketPurchases = Math.max(1, Math.round(todayPurchases * (0.72 + bucketNoise * 0.56)));
      salesTrend.push({
        bucket: new Date(Date.UTC(bucketDate.getUTCFullYear(), bucketDate.getUTCMonth(), bucketDate.getUTCDate())).toISOString(),
        revenue: Math.round(bucketPurchases * profile.avgOrderValue),
        purchases: bucketPurchases,
      });
    }

    const products = [
      'prod_001',
      'prod_004',
      'prod_007',
      'prod_010',
      'prod_013',
      'prod_016',
      'prod_019',
      'prod_022',
      'prod_003',
      'prod_006',
    ].map((productId, idx) => {
      const productNoise = this.deterministicNoise(`${storeId}:prod:${productId}`);
      const revenue = Math.round(selectedRevenue * (0.16 - idx * 0.012) * (0.82 + productNoise * 0.26));
      return {
        product_id: productId,
        name: DISPLAY_NAMES_BY_PRODUCT_ID[productId] ?? `Product ${productId}`,
        revenue: Math.max(0, revenue),
      };
    });

    const tickBucket = Math.floor(now.getTime() / 2500);
    const productOffset = (syntheticTick.totalPurchases + tickBucket) % products.length;
    const recentActivity: DashboardSnapshot['recentActivity'] = Array.from({ length: 20 }, (_, idx) => {
      const movingSeed = `${storeId}:activity:${tickBucket}:${idx}`;
      const minutesAgo = idx * 2 + Math.floor(this.deterministicNoise(movingSeed) * 4);
      const secondsAgo = Math.floor(this.deterministicNoise(`${movingSeed}:sec`) * 58);
      const ts = new Date(now.getTime() - minutesAgo * 60 * 1000 - secondsAgo * 1000).toISOString();
      const eventPick = Math.floor(this.deterministicNoise(`${movingSeed}:type`) * 10);
      const isPurchase = eventPick <= 2 || (idx % 7 === 0 && eventPick <= 4);
      const eventType = isPurchase ? 'purchase' : eventPick <= 6 ? 'add_to_cart' : 'page_view';
      const productId = products[(idx + productOffset) % products.length]?.product_id ?? 'prod_001';
      const amount = isPurchase
        ? Math.round(profile.avgOrderValue * (0.68 + this.deterministicNoise(`${movingSeed}:amount`) * 0.95))
        : null;

      return {
        eventId: `fallback_${storeId}_${idx}_${Math.floor(now.getTime() / 1000)}`,
        storeId,
        eventType,
        timestamp: ts,
        data: {
          productId,
          amount,
          currency: amount ? 'USD' : null,
        },
      };
    });

    const funnelCounts = normalizeFunnelJourneyCounts({
      page_view: pageViews,
      add_to_cart: addToCart,
      checkout_started: checkoutStarted,
      remove_from_cart: removeFromCart,
      purchase,
    });

    const funnel = {
      steps: [
        { stage: 'page_view', count: funnelCounts.page_view, prev: null as number | null },
        { stage: 'add_to_cart', count: funnelCounts.add_to_cart, prev: funnelCounts.page_view },
        { stage: 'checkout_started', count: funnelCounts.checkout_started, prev: funnelCounts.add_to_cart },
        { stage: 'remove_from_cart', count: funnelCounts.remove_from_cart, prev: funnelCounts.checkout_started },
        { stage: 'purchase', count: funnelCounts.purchase, prev: funnelCounts.remove_from_cart },
      ].map((step) => ({
        stage: step.stage,
        count: step.count,
        dropOffPct:
          step.prev && step.prev > 0
            ? Number((((step.prev - step.count) / step.prev) * 100).toFixed(2))
            : null,
      })),
    };

    return {
      overview: {
        revenue: {
          today: todayRevenue,
          thisWeek: weekRevenue,
          thisMonth: monthRevenue,
          selectedRange: selectedRevenue,
          periodKeys: {
            today: dayKey,
            week: dayKey,
            month: monthKey,
          },
        },
        eventCounts: {
          page_view: pageViews,
          add_to_cart: addToCart,
          remove_from_cart: removeFromCart,
          checkout_started: checkoutStarted,
          purchase,
        },
        conversionRate,
        audience: {
          uniqueVisitors,
          distinctPurchasers,
          sessionsWithCartNoPurchase: Math.max(0, addToCart - purchase),
        },
      },
      topProducts: products,
      recentActivity,
      liveVisitors: {
        activeVisitors: Math.max(
          1,
          Math.round(
            profile.liveVisitors * (0.9 + noise * 0.2) +
              ((syntheticTick.totalPurchases % 9) - 4),
          ),
        ),
        windowMinutes: 5,
      },
      salesTrend,
      funnel,
    };
  }

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly config: ConfigService,
  ) {}

  /** IANA zone for calendar day / ISO week / month boundaries (not rolling 24h windows). */
  private analyticsTimezone(): string {
    const raw = this.config.get<string>('ANALYTICS_TIMEZONE', 'UTC')?.trim();
    const candidate = raw && raw.length > 0 ? raw : 'UTC';
    try {
      Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      this.logger.warn(`ANALYTICS_TIMEZONE "${candidate}" is invalid; falling back to UTC`);
      return 'UTC';
    }
  }

  private pruneMemoryCache() {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache) {
      if (entry.expiresAt < now) {
        this.memoryCache.delete(key);
      }
    }

    while (this.memoryCache.size > this.memoryCacheMaxEntries) {
      const oldestKey = this.memoryCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.memoryCache.delete(oldestKey);
    }
  }

  private getMemoryCached<T>(key: string): T | null {
    const hit = this.memoryCache.get(key);
    if (!hit) {
      return null;
    }

    if (hit.expiresAt < Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }

    return hit.value as T;
  }

  private setMemoryCached(key: string, value: unknown, ttlSeconds: number) {
    this.pruneMemoryCache();
    this.memoryCache.set(key, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      value,
    });
  }

  private async getCached<T>(key: string): Promise<T | null> {
    if (!this.redis) {
      return null;
    }

    try {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async setCached(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      return;
    }
  }

  private getWindow(startDate?: string, endDate?: string) {
    const now = new Date();
    const end = endDate ? new Date(endDate) : now;
    const start = startDate ? new Date(startDate) : new Date(new Date(now).setHours(0, 0, 0, 0));

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      this.logger.warn(
        `Invalid date window startDate=${String(startDate)} endDate=${String(endDate)} — using today 00:00 → now`,
      );
      const s = new Date(new Date(now).setHours(0, 0, 0, 0));
      return { start: s, end: now };
    }

    if (start.getTime() > end.getTime()) {
      this.logger.warn('Date window start after end — swapping bounds');
      return { start: end, end: start };
    }

    return { start, end };
  }

  /** Purchase revenue: one SUM per calendar bucket (day / week / month) plus the selected date range. */
  private async getOverviewCalendarRevenue(
    db: Pick<Pool, 'query'> | PoolClient,
    storeId: string,
    rangeStart: Date,
    rangeEnd: Date,
    tz: string,
  ): Promise<CalendarRevenueRow> {
    const result = await db.query<CalendarRevenueRow>(REVENUE_BY_CALENDAR_BUCKETS_SQL, [
      storeId,
      rangeStart.toISOString(),
      rangeEnd.toISOString(),
      tz,
    ]);
    const row = result.rows[0];
    if (!row) {
      this.logger.error('Calendar revenue query returned no row (unexpected); using zeros');
      return {
        revenue_today: 0,
        revenue_week: 0,
        revenue_month: 0,
        revenue_selected_range: 0,
        period_day_key: '',
        period_week_key: '',
        period_month_key: '',
      };
    }
    return row;
  }

  async getOverview(storeId: string, startDate?: string, endDate?: string, cacheTtlSeconds = 30) {
    const { start, end } = this.getWindow(startDate, endDate);
    const tz = this.analyticsTimezone();
    const cacheKey = `overview:v7:${storeId}:${tz}:${start.toISOString()}:${end.toISOString()}`;

    const useCache = cacheTtlSeconds > 0;
    if (useCache) {
      const memoryCached = this.getMemoryCached<{
        revenue: {
          today: number;
          thisWeek: number;
          thisMonth: number;
          selectedRange: number;
          periodKeys: RevenuePeriodKeys;
        };
        eventCounts: Record<EventType, number>;
        conversionRate: number;
        audience: AudienceMetrics;
      }>(cacheKey);

      if (memoryCached) {
        return memoryCached;
      }

      const cached = await this.getCached<{
        revenue: {
          today: number;
          thisWeek: number;
          thisMonth: number;
          selectedRange: number;
          periodKeys: RevenuePeriodKeys;
        };
        eventCounts: Record<EventType, number>;
        conversionRate: number;
        audience: AudienceMetrics;
      }>(cacheKey);

      if (cached) {
        this.setMemoryCached(cacheKey, cached, cacheTtlSeconds);
        return cached;
      }
    }

    try {
      let revenue: CalendarRevenueRow;
      try {
        revenue = await this.getOverviewCalendarRevenue(this.pool, storeId, start, end, tz);
      } catch (calendarErr) {
        if (tz !== 'UTC') {
          const msg = calendarErr instanceof Error ? calendarErr.message : String(calendarErr);
          this.logger.warn(
            `Calendar revenue failed for ANALYTICS_TIMEZONE=${tz} (${msg}); retrying with UTC`,
          );
          revenue = await this.getOverviewCalendarRevenue(this.pool, storeId, start, end, 'UTC');
        } else {
          throw calendarErr;
        }
      }

      const [eventCountsResult, audienceResult] = await Promise.all([
        this.pool.query(
          `
          SELECT
            COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS page_view,
            COUNT(*) FILTER (WHERE event_type = 'add_to_cart')::int AS add_to_cart,
            COUNT(*) FILTER (WHERE event_type = 'remove_from_cart')::int AS remove_from_cart,
            COUNT(*) FILTER (WHERE event_type = 'checkout_started')::int AS checkout_started,
            COUNT(*) FILTER (WHERE event_type = 'purchase')::int AS purchase
          FROM analytics_events
          WHERE store_id = $1
            AND timestamp >= $2
            AND timestamp <= $3
          `,
          [storeId, start.toISOString(), end.toISOString()],
        ),
        this.pool.query(
          `
          SELECT
            COUNT(DISTINCT CASE WHEN event_type = 'page_view' AND session_id IS NOT NULL THEN session_id END)::int
              AS unique_visitors,
            COUNT(DISTINCT CASE
              WHEN event_type = 'purchase'
                AND session_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM analytics_events pv
                  WHERE pv.store_id = $1
                    AND pv.session_id = analytics_events.session_id
                    AND pv.event_type = 'page_view'
                    AND pv.timestamp >= $2
                    AND pv.timestamp <= $3
                )
              THEN session_id
            END)::int
              AS distinct_purchasers,
            (
              SELECT COUNT(DISTINCT c.session_id)::int
              FROM analytics_events c
              WHERE c.store_id = $1
                AND c.event_type = 'add_to_cart'
                AND c.session_id IS NOT NULL
                AND c.timestamp >= $2
                AND c.timestamp <= $3
                AND NOT EXISTS (
                  SELECT 1
                  FROM analytics_events p
                  WHERE p.store_id = $1
                    AND p.session_id = c.session_id
                    AND p.event_type = 'purchase'
                    AND p.timestamp >= $2
                    AND p.timestamp <= $3
                )
            ) AS sessions_with_cart_no_purchase
          FROM analytics_events
          WHERE store_id = $1
            AND timestamp >= $2
            AND timestamp <= $3
          `,
          [storeId, start.toISOString(), end.toISOString()],
        ),
      ]);

      const counts = eventCountsResult.rows[0] as {
        page_view: number;
        add_to_cart: number;
        remove_from_cart: number;
        checkout_started: number;
        purchase: number;
      };

      const eventCounts = {
        page_view: Number(counts.page_view ?? 0),
        add_to_cart: Number(counts.add_to_cart ?? 0),
        remove_from_cart: Number(counts.remove_from_cart ?? 0),
        checkout_started: Number(counts.checkout_started ?? 0),
        purchase: Number(counts.purchase ?? 0),
      };

      const aud = audienceResult.rows[0] as {
        unique_visitors: number;
        distinct_purchasers: number;
        sessions_with_cart_no_purchase: number;
      };

      const audience: AudienceMetrics = {
        uniqueVisitors: Number(aud?.unique_visitors ?? 0),
        distinctPurchasers: Number(aud?.distinct_purchasers ?? 0),
        sessionsWithCartNoPurchase: Number(aud?.sessions_with_cart_no_purchase ?? 0),
      };
      const conversionRate =
        audience.uniqueVisitors === 0
          ? 0
          : Number(((Math.min(audience.distinctPurchasers, audience.uniqueVisitors) / audience.uniqueVisitors) * 100).toFixed(2));

      const periodKeys: RevenuePeriodKeys = {
        today: String(revenue.period_day_key ?? ''),
        week: String(revenue.period_week_key ?? ''),
        month: String(revenue.period_month_key ?? ''),
      };

      const payload = {
        revenue: {
          today: Number(revenue.revenue_today),
          thisWeek: Number(revenue.revenue_week),
          thisMonth: Number(revenue.revenue_month),
          selectedRange: Number(revenue.revenue_selected_range ?? 0),
          periodKeys,
        },
        eventCounts,
        conversionRate,
        audience,
      };

      if (useCache) {
        await this.setCached(cacheKey, payload, cacheTtlSeconds);
        this.setMemoryCached(cacheKey, payload, cacheTtlSeconds);
      }
      return payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`getOverview failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      throw new InternalServerErrorException('Failed to fetch overview analytics');
    }
  }

  async getTopProducts(storeId: string, limit: number, startDate?: string, endDate?: string, cacheTtlSeconds = 30) {
    const { start, end } = this.getWindow(startDate, endDate);
    const cacheKey = `top-products:${storeId}:${limit}:${start.toISOString()}:${end.toISOString()}`;

    const useCache = cacheTtlSeconds > 0;
    if (useCache) {
      const memoryCached = this.getMemoryCached<Array<{ product_id: string; name: string; revenue: number }>>(cacheKey);
      if (memoryCached) {
        return memoryCached;
      }

      const cached = await this.getCached<Array<{ product_id: string; name: string; revenue: number }>>(cacheKey);
      if (cached) {
        this.setMemoryCached(cacheKey, cached, cacheTtlSeconds);
        return cached;
      }
    }

    try {
      const result = await this.pool.query<TopProductRow>(
        `
        SELECT
          product_id,
          COALESCE(SUM(amount), 0)::float AS revenue
        FROM analytics_events
        WHERE store_id = $1
          AND event_type = 'purchase'
          AND product_id IS NOT NULL
          AND timestamp >= $3
          AND timestamp <= $4
        GROUP BY product_id
        ORDER BY revenue DESC
        LIMIT $2
        `,
        [storeId, limit, start.toISOString(), end.toISOString()],
      );

      const payload = result.rows.map((row: TopProductRow) => ({
        product_id: row.product_id,
        name: DISPLAY_NAMES_BY_PRODUCT_ID[row.product_id] ?? `Product ${row.product_id}`,
        revenue: Number(row.revenue),
      }));

      if (useCache) {
        await this.setCached(cacheKey, payload, cacheTtlSeconds);
        this.setMemoryCached(cacheKey, payload, cacheTtlSeconds);
      }
      return payload;
    } catch {
      throw new InternalServerErrorException('Failed to fetch top products');
    }
  }

  async getRecentActivity(
    storeId: string,
    limit: number,
    eventType?: EventType,
    startDate?: string,
    endDate?: string,
  ) {
    try {
      const { start, end } = this.getWindow(startDate, endDate);
      const values: Array<string | number> = [storeId, start.toISOString(), end.toISOString()];
      let paramIndex = 4;
      let typeClause = '';
      if (eventType) {
        typeClause = `AND event_type = $${paramIndex}`;
        values.push(eventType);
        paramIndex += 1;
      }
      values.push(limit);
      const limitParam = `$${paramIndex}`;

      const result = await this.pool.query<RecentActivityRow>(
        `
        SELECT event_id, store_id, event_type, timestamp, product_id, amount, currency
        FROM analytics_events
        WHERE store_id = $1
          AND timestamp >= $2::timestamptz
          AND timestamp <= $3::timestamptz
          ${typeClause}
        ORDER BY timestamp DESC
        LIMIT ${limitParam}
        `,
        values,
      );

      return result.rows.map((row: RecentActivityRow) => ({
          eventId: row.event_id,
          storeId: row.store_id,
          eventType: row.event_type,
          timestamp: row.timestamp,
          data: {
            productId: row.product_id,
            amount: row.amount !== null ? Number(row.amount) : null,
            currency: row.currency,
          },
      }));
    } catch {
      throw new InternalServerErrorException('Failed to fetch recent activity');
    }
  }

  async getLiveVisitors(storeId: string, minutes: number) {
    try {
      const result = await this.pool.query<LiveVisitorsRow>(
        `
        SELECT COUNT(DISTINCT session_id)::int AS active_visitors
        FROM analytics_events
        WHERE store_id = $1
          AND event_type = 'page_view'
          AND session_id IS NOT NULL
          AND timestamp >= now() - ($2::double precision * interval '1 minute')
        `,
        [storeId, minutes],
      );

      return {
        activeVisitors: Number(result.rows[0]?.active_visitors ?? 0),
        windowMinutes: minutes,
      };
    } catch {
      throw new InternalServerErrorException('Failed to fetch live visitors');
    }
  }

  async getSalesTrend(storeId: string, interval: 'hour' | 'day', startDate?: string, endDate?: string, cacheTtlSeconds = 30) {
    const { start, end } = this.getWindow(startDate, endDate);
    const cacheKey = `sales-trend:${storeId}:${interval}:${start.toISOString()}:${end.toISOString()}`;

    const useCache = cacheTtlSeconds > 0;
    if (useCache) {
      const memoryCached = this.getMemoryCached<Array<{ bucket: string; revenue: number; purchases: number }>>(cacheKey);
      if (memoryCached) {
        return memoryCached;
      }

      const cached = await this.getCached<Array<{ bucket: string; revenue: number; purchases: number }>>(cacheKey);
      if (cached) {
        this.setMemoryCached(cacheKey, cached, cacheTtlSeconds);
        return cached;
      }
    }

    try {
      const bucketExpr = interval === 'hour' ? "date_trunc('hour', timestamp)" : "date_trunc('day', timestamp)";

      const result = await this.pool.query<SalesTrendRow>(
        `
        SELECT
          to_char(${bucketExpr}, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
          COALESCE(SUM(amount), 0)::float AS revenue,
          COUNT(*)::int AS purchases
        FROM analytics_events
        WHERE store_id = $1
          AND event_type = 'purchase'
          AND timestamp >= $2
          AND timestamp <= $3
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        [storeId, start.toISOString(), end.toISOString()],
      );

      const payload = result.rows.map((row) => ({
        bucket: row.bucket,
        revenue: Number(row.revenue),
        purchases: Number(row.purchases),
      }));

      if (useCache) {
        await this.setCached(cacheKey, payload, cacheTtlSeconds);
        this.setMemoryCached(cacheKey, payload, cacheTtlSeconds);
      }
      return payload;
    } catch {
      throw new InternalServerErrorException('Failed to fetch sales trend');
    }
  }

  async getFunnel(storeId: string, startDate?: string, endDate?: string, cacheTtlSeconds = 30) {
    const { start, end } = this.getWindow(startDate, endDate);
    const cacheKey = `funnel:v2:${storeId}:${start.toISOString()}:${end.toISOString()}`;

    const useCache = cacheTtlSeconds > 0;
    if (useCache) {
      const memoryCached = this.getMemoryCached<{
        steps: Array<{ stage: string; count: number; dropOffPct: number | null }>;
      }>(cacheKey);

      if (memoryCached) {
        return memoryCached;
      }

      const cached = await this.getCached<{
        steps: Array<{ stage: string; count: number; dropOffPct: number | null }>;
      }>(cacheKey);

      if (cached) {
        this.setMemoryCached(cacheKey, cached, cacheTtlSeconds);
        return cached;
      }
    }

    try {
      const result = await this.pool.query<FunnelRow>(
        `
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS page_view,
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart')::int AS add_to_cart,
          COUNT(*) FILTER (WHERE event_type = 'checkout_started')::int AS checkout_started,
          COUNT(*) FILTER (WHERE event_type = 'remove_from_cart')::int AS remove_from_cart,
          COUNT(*) FILTER (WHERE event_type = 'purchase')::int AS purchase
        FROM analytics_events
        WHERE store_id = $1
          AND timestamp >= $2
          AND timestamp <= $3
        `,
        [storeId, start.toISOString(), end.toISOString()],
      );

      const row = result.rows[0];
      const norm = normalizeFunnelJourneyCounts({
        page_view: row?.page_view ?? 0,
        add_to_cart: row?.add_to_cart ?? 0,
        checkout_started: row?.checkout_started ?? 0,
        remove_from_cart: row?.remove_from_cart ?? 0,
        purchase: row?.purchase ?? 0,
      });
      const pageView = norm.page_view;
      const addToCart = norm.add_to_cart;
      const checkoutStarted = norm.checkout_started;
      const removeFromCart = norm.remove_from_cart;
      const purchase = norm.purchase;

      /** Journey order for the dashboard: views → cart → checkout → removals → purchases */
      const steps = [
        { stage: 'page_view', count: pageView, prev: null as number | null },
        { stage: 'add_to_cart', count: addToCart, prev: pageView },
        { stage: 'checkout_started', count: checkoutStarted, prev: addToCart },
        { stage: 'remove_from_cart', count: removeFromCart, prev: checkoutStarted },
        { stage: 'purchase', count: purchase, prev: removeFromCart },
      ].map((step) => ({
        stage: step.stage,
        count: step.count,
        dropOffPct:
          step.prev && step.prev > 0
            ? Number((((step.prev - step.count) / step.prev) * 100).toFixed(2))
            : null,
      }));

      const payload = { steps };
      if (useCache) {
        await this.setCached(cacheKey, payload, cacheTtlSeconds);
        this.setMemoryCached(cacheKey, payload, cacheTtlSeconds);
      }
      return payload;
    } catch {
      throw new InternalServerErrorException('Failed to fetch funnel analytics');
    }
  }

  async getDashboardSnapshot(
    storeId: string,
    startDate?: string,
    endDate?: string,
    cacheTtlSeconds = 0,
  ): Promise<DashboardSnapshot> {
    if (this.forceSyntheticMode()) {
      return this.buildFallbackDashboardSnapshot(storeId, startDate, endDate);
    }

    const now = Date.now();
    if (this.dbFailureCooldownUntil > now) {
      return this.buildFallbackDashboardSnapshot(storeId, startDate, endDate);
    }

    try {
      const [overview, topProducts, recentActivity, liveVisitors, salesTrend, funnel] = await Promise.all([
        this.getOverview(storeId, startDate, endDate, cacheTtlSeconds),
        this.getTopProducts(storeId, 10, startDate, endDate, cacheTtlSeconds),
        this.getRecentActivity(storeId, 20, undefined, startDate, endDate),
        this.getLiveVisitors(storeId, 5),
        this.getSalesTrend(storeId, 'day', startDate, endDate, cacheTtlSeconds),
        this.getFunnel(storeId, startDate, endDate, cacheTtlSeconds),
      ]);

      return { overview, topProducts, recentActivity, liveVisitors, salesTrend, funnel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.dbFailureCooldownUntil = Date.now() + 15_000;
      this.logger.warn(
        `Falling back to generated dashboard snapshot for ${storeId} (${msg || 'unknown error'})`,
      );
      return this.buildFallbackDashboardSnapshot(storeId, startDate, endDate);
    }
  }
}
