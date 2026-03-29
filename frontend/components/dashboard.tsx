"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DashboardData, RevenuePeriodKeys } from "../lib/api";
import { fetchDashboard, logoutOwner } from "../lib/api";
import {
  clearDashboardCache,
  readDashboardCache,
  writeDashboardCache,
} from "../lib/dashboard-cache";
import { Activity, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from "recharts";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { clearAuthSession, getOwnerSession, hasAuthSession } from "../lib/auth";

type DashboardState = DashboardData;

const FALLBACK_WINDOW_MINUTES = 5;

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toWhole(value: unknown, fallback = 0) {
  return Math.max(0, Math.round(toFiniteNumber(value, fallback)));
}

function normalizeDashboardState(input: DashboardState): DashboardState {
  const revIn = input.overview.revenue;
  const revToday = Math.max(0, toFiniteNumber(revIn.today));
  const revWeek = Math.max(revToday, toFiniteNumber(revIn.thisWeek));
  const revMonth = Math.max(revWeek, toFiniteNumber(revIn.thisMonth));
  const revRange = Math.max(0, toFiniteNumber(revIn.selectedRange));

  const ecIn = input.overview.eventCounts ?? {};
  const pageView = toWhole(ecIn.page_view);
  const addToCart = Math.min(pageView, toWhole(ecIn.add_to_cart));
  const checkoutStarted = Math.min(addToCart, toWhole(ecIn.checkout_started));
  const removeFromCart = Math.min(
    checkoutStarted,
    toWhole(ecIn.remove_from_cart),
  );
  const purchase = Math.min(removeFromCart, toWhole(ecIn.purchase));

  const uniqueVisitors = toWhole(input.overview.audience?.uniqueVisitors);
  const distinctPurchasers = Math.min(
    uniqueVisitors,
    toWhole(input.overview.audience?.distinctPurchasers),
  );
  const sessionsWithCartNoPurchase = Math.min(
    Math.max(0, uniqueVisitors - distinctPurchasers),
    toWhole(input.overview.audience?.sessionsWithCartNoPurchase),
  );

  const conversionRate =
    uniqueVisitors === 0
      ? 0
      : Number(
          Math.min(100, (distinctPurchasers / uniqueVisitors) * 100).toFixed(2),
        );

  const topProducts = [...(input.topProducts ?? [])]
    .map((item) => ({
      ...item,
      revenue: Math.max(0, toFiniteNumber(item.revenue)),
      name: item.name?.trim() || item.product_id,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const salesTrend = [...(input.salesTrend ?? [])]
    .map((point) => ({
      bucket: point.bucket,
      revenue: Math.max(0, toFiniteNumber(point.revenue)),
      purchases: toWhole(point.purchases),
    }))
    .sort(
      (a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime(),
    );

  const recentActivity = [...(input.recentActivity ?? [])]
    .map((event) => ({
      ...event,
      data: {
        ...event.data,
        amount:
          event.data.amount == null
            ? null
            : Math.max(0, toFiniteNumber(event.data.amount)),
      },
    }))
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

  return {
    ...input,
    overview: {
      ...input.overview,
      revenue: {
        ...input.overview.revenue,
        today: revToday,
        thisWeek: revWeek,
        thisMonth: revMonth,
        selectedRange: revRange,
      },
      eventCounts: {
        ...ecIn,
        page_view: pageView,
        add_to_cart: addToCart,
        checkout_started: checkoutStarted,
        remove_from_cart: removeFromCart,
        purchase,
      },
      conversionRate,
      audience: {
        uniqueVisitors,
        distinctPurchasers,
        sessionsWithCartNoPurchase,
      },
    },
    topProducts,
    recentActivity,
    liveVisitors: {
      activeVisitors: toWhole(input.liveVisitors?.activeVisitors),
      windowMinutes: Math.max(
        1,
        toWhole(input.liveVisitors?.windowMinutes, FALLBACK_WINDOW_MINUTES),
      ),
    },
    salesTrend,
    funnel: {
      ...input.funnel,
      steps: [
        { stage: "page_view", count: pageView, dropOffPct: null },
        {
          stage: "add_to_cart",
          count: addToCart,
          dropOffPct:
            pageView === 0
              ? 0
              : Number((((pageView - addToCart) / pageView) * 100).toFixed(2)),
        },
        {
          stage: "checkout_started",
          count: checkoutStarted,
          dropOffPct:
            addToCart === 0
              ? 0
              : Number(
                  (((addToCart - checkoutStarted) / addToCart) * 100).toFixed(
                    2,
                  ),
                ),
        },
        {
          stage: "remove_from_cart",
          count: removeFromCart,
          dropOffPct:
            checkoutStarted === 0
              ? 0
              : Number(
                  (
                    ((checkoutStarted - removeFromCart) / checkoutStarted) *
                    100
                  ).toFixed(2),
                ),
        },
        {
          stage: "purchase",
          count: purchase,
          dropOffPct:
            removeFromCart === 0
              ? 0
              : Number(
                  (
                    ((removeFromCart - purchase) / removeFromCart) *
                    100
                  ).toFixed(2),
                ),
        },
      ],
    },
  };
}

function currency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function pct(value: number) {
  return `${value.toFixed(2)}%`;
}

/** Fixed locale so SSR + client match (avoids en-IN vs en-US hydration mismatches). */
function formatIntegerCount(n: number): string {
  return n.toLocaleString("en-US");
}

const activityTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

function formatActivityTime(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return `${activityTimeFormatter.format(d)} UTC`;
}

function formatSyncedClock(d: Date) {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Calendar date in the user's local timezone (matches `<input type="date">`). */
function localDateKey(value: Date) {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Monday-start week key (local calendar), aligned with dashboard date inputs. */
function localWeekStartKey(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dowFromMon = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dowFromMon);
  return localDateKey(x);
}

function demoPeriodKeysForDate(now: Date): RevenuePeriodKeys {
  return {
    today: localDateKey(now),
    week: localWeekStartKey(now),
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  };
}

/** Deterministic PRNG so demo dashboard metrics don’t reshuffle on every poll. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rangeToApiIso(startYmd: string, endYmd: string) {
  const start = new Date(`${startYmd}T00:00:00`);
  const end = new Date(`${endYmd}T23:59:59.999`);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function niceDateLabel(value: string) {
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** Auto-refresh interval for live dashboard polling (2-3s target). */
const DASHBOARD_POLL_MS = 2500;

/** Canonical journey order for charts (not sorted by raw count). */
const FUNNEL_EVENT_ORDER = [
  "page_view",
  "add_to_cart",
  "checkout_started",
  "remove_from_cart",
  "purchase",
] as const;

const FUNNEL_STAGE_LABEL: Record<(typeof FUNNEL_EVENT_ORDER)[number], string> =
  {
    page_view: "Page views",
    add_to_cart: "Add to cart",
    checkout_started: "Checkout started",
    remove_from_cart: "Removed from cart",
    purchase: "Purchased",
  };

const DEMO_PRODUCT_NAMES: Record<string, string> = Object.fromEntries(
  [
    "Linen throw blanket",
    "Ceramic pour-over set",
    "Oak floating shelf",
    "LED desk lamp",
    "Wool runner rug",
    "Stainless kettle",
    "Bamboo utensil tray",
    "Cotton duvet cover",
    "Glass storage canisters",
    "Matte ceramic vase",
    "Brass cabinet pull set",
    "Recycled glass tumbler",
    "Teak bath mat",
    "Linen apron",
    "Cast iron skillet",
    "Marble coasters (set)",
    "Jute tote bag",
    "Hemp shower curtain",
    "Walnut cutting board",
    "Silicone baking mat",
    "Copper measuring cups",
    "Canvas storage bin",
    "Rattan pendant shade",
    "Stone soap dish",
    "Organic cotton towels",
  ].map((name, i) => [`prod_${String(i + 1).padStart(3, "0")}`, name]),
);

function pickEventTypeFromMix(
  rng: () => number,
  mix: ReadonlyArray<{
    type: (typeof FUNNEL_EVENT_ORDER)[number];
    weight: number;
  }>,
): (typeof FUNNEL_EVENT_ORDER)[number] {
  const total = mix.reduce((s, m) => s + m.weight, 0);
  const r = rng() * total;
  let acc = 0;
  for (const { type, weight } of mix) {
    acc += weight;
    if (r < acc) {
      return type;
    }
  }
  return mix[mix.length - 1]?.type ?? "page_view";
}

/** Coherent funnel totals: PV ≫ ATC > CO ≥ RM > PUR (same idea as backend seed). */
function sampleDemoFunnelCounts(
  total: number,
  rng: () => number = Math.random,
) {
  const t = Math.max(220, Math.floor(total));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const pvCore = Math.floor(t * (0.48 + rng() * 0.06));
    const atc = Math.max(40, Math.floor(pvCore * (0.14 + rng() * 0.1)));
    const co = Math.max(15, Math.floor(atc * (0.22 + rng() * 0.22)));
    const rm = Math.max(
      8,
      Math.min(Math.floor(co * (0.38 + rng() * 0.42)), co),
    );
    const purCap = Math.max(1, rm - 1);
    const pur = Math.max(
      1,
      Math.min(Math.floor(rm * (0.12 + rng() * 0.22)), purCap),
    );
    const fixed = atc + co + rm + pur;
    const pageView = t - fixed;
    if (pageView > atc * 1.35) {
      return {
        pageView,
        addToCart: atc,
        checkoutStarted: co,
        removeFromCart: rm,
        purchase: pur,
      };
    }
  }
  const atc = Math.floor(t * 0.16);
  const co = Math.floor(atc * 0.38);
  const rm = Math.min(Math.floor(co * 0.55), co);
  const pur = Math.max(1, Math.min(Math.floor(rm * 0.22), rm - 1));
  return {
    pageView: t - atc - co - rm - pur,
    addToCart: atc,
    checkoutStarted: co,
    removeFromCart: rm,
    purchase: pur,
  };
}

function MetricCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="font-heading text-3xl font-semibold tracking-tight">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

type DemoStoreProfile = {
  trafficBase: number;
  purchaseRate: number;
  avgOrderValue: number;
  trendBase: number;
  trendSlope: number;
  liveVisitorsBase: number;
  topProductSlots: number;
  /** Recent-activity row mix (weights need not sum to 1; normalized when sampling). */
  eventMix: ReadonlyArray<{
    type: (typeof FUNNEL_EVENT_ORDER)[number];
    weight: number;
  }>;
};

const DEMO_STORE_PROFILES: Record<string, DemoStoreProfile> = {
  store_001: {
    trafficBase: 218_000,
    purchaseRate: 0.095,
    avgOrderValue: 126,
    trendBase: 10_200,
    trendSlope: 0.072,
    liveVisitorsBase: 520,
    topProductSlots: 10,
    eventMix: [
      { type: "page_view", weight: 38 },
      { type: "add_to_cart", weight: 24 },
      { type: "checkout_started", weight: 14 },
      { type: "remove_from_cart", weight: 10 },
      { type: "purchase", weight: 14 },
    ],
  },
  store_002: {
    trafficBase: 58_000,
    purchaseRate: 0.062,
    avgOrderValue: 86,
    trendBase: 3100,
    trendSlope: 0.05,
    liveVisitorsBase: 168,
    topProductSlots: 8,
    eventMix: [
      { type: "page_view", weight: 46 },
      { type: "add_to_cart", weight: 22 },
      { type: "checkout_started", weight: 12 },
      { type: "remove_from_cart", weight: 10 },
      { type: "purchase", weight: 10 },
    ],
  },
  store_003: {
    trafficBase: 9200,
    purchaseRate: 0.034,
    avgOrderValue: 61,
    trendBase: 420,
    trendSlope: 0.028,
    liveVisitorsBase: 24,
    topProductSlots: 5,
    eventMix: [
      { type: "page_view", weight: 54 },
      { type: "add_to_cart", weight: 22 },
      { type: "checkout_started", weight: 10 },
      { type: "remove_from_cart", weight: 10 },
      { type: "purchase", weight: 4 },
    ],
  },
};

/** 20-row shell: flagship shows steady purchases; new store is mostly browsing. */
const DETERMINISTIC_ACTIVITY_SEQ: Record<
  string,
  (typeof FUNNEL_EVENT_ORDER)[number][]
> = {
  store_001: [
    "page_view",
    "add_to_cart",
    "checkout_started",
    "purchase",
    "page_view",
    "add_to_cart",
    "purchase",
    "page_view",
    "checkout_started",
    "remove_from_cart",
    "purchase",
    "page_view",
    "add_to_cart",
    "checkout_started",
    "purchase",
    "page_view",
    "add_to_cart",
    "purchase",
    "page_view",
    "purchase",
  ],
  store_002: [
    "page_view",
    "page_view",
    "add_to_cart",
    "checkout_started",
    "purchase",
    "page_view",
    "add_to_cart",
    "remove_from_cart",
    "checkout_started",
    "purchase",
    "page_view",
    "add_to_cart",
    "checkout_started",
    "page_view",
    "purchase",
    "page_view",
    "add_to_cart",
    "checkout_started",
    "remove_from_cart",
    "purchase",
  ],
  store_003: [
    "page_view",
    "page_view",
    "page_view",
    "add_to_cart",
    "page_view",
    "checkout_started",
    "page_view",
    "add_to_cart",
    "remove_from_cart",
    "page_view",
    "page_view",
    "add_to_cart",
    "checkout_started",
    "page_view",
    "page_view",
    "purchase",
    "page_view",
    "add_to_cart",
    "page_view",
    "purchase",
  ],
};

function buildDemoDashboardData(
  options: {
    deterministic?: boolean;
    random?: () => number;
    storeId?: string;
  } = {},
) {
  const { deterministic = false, random, storeId = "store_001" } = options;
  const rng = deterministic ? () => 0.5 : (random ?? Math.random);
  const now = deterministic ? new Date("2024-06-15T12:00:00.000Z") : new Date();
  const profile = DEMO_STORE_PROFILES[storeId] ?? DEMO_STORE_PROFILES.store_002;

  const baseTotal = Math.round(profile.trafficBase * (0.92 + rng() * 0.16));
  const funnelTotals = deterministic
    ? sampleDemoFunnelCounts(baseTotal, () => 0.5)
    : sampleDemoFunnelCounts(baseTotal, rng);

  const { pageView, addToCart, checkoutStarted, removeFromCart, purchase } =
    funnelTotals;

  const detActivitySeq =
    DETERMINISTIC_ACTIVITY_SEQ[storeId] ?? DETERMINISTIC_ACTIVITY_SEQ.store_002;

  const recentActivity = Array.from({ length: 20 }, (_, i) => {
    const eventType = deterministic
      ? detActivitySeq[i]!
      : pickEventTypeFromMix(rng, profile.eventMix);
    const prodN = ((i * 7 + 3) % 25) + 1;
    const productId =
      eventType === "purchase" ||
      eventType === "add_to_cart" ||
      eventType === "remove_from_cart"
        ? `prod_${String(prodN).padStart(3, "0")}`
        : i % 3 === 0
          ? null
          : `prod_${String(prodN).padStart(3, "0")}`;
    const isPurchase = eventType === "purchase";
    return {
      eventId: deterministic
        ? `shell_evt_${i}`
        : `demo_evt_${now.getTime()}_${i}_${rng().toString(36).slice(2, 9)}`,
      storeId,
      eventType,
      timestamp: new Date(now.getTime() - i * 47_000).toISOString(),
      data: {
        productId,
        amount: isPurchase
          ? Number(
              (
                profile.avgOrderValue * (0.62 + rng() * 0.9) +
                (i % 4) * 4.75
              ).toFixed(2),
            )
          : null,
        currency: isPurchase ? "USD" : null,
      },
    };
  });

  const selectedRangeRevenue = Math.round(
    purchase * profile.avgOrderValue * (0.9 + rng() * 0.3),
  );
  const uniqueVisitors = Math.min(
    pageView,
    Math.round(pageView * (0.24 + rng() * 0.1)),
  );
  const sessionsWithCartNoPurchase = Math.max(
    0,
    Math.round(addToCart * (0.18 + rng() * 0.12)),
  );

  const todayRaw = Math.round(selectedRangeRevenue * (0.12 + rng() * 0.04));
  const weekRaw = Math.max(todayRaw, Math.round(selectedRangeRevenue * (0.84 + rng() * 0.12)));
  const monthRaw = Math.max(weekRaw, Math.round(selectedRangeRevenue * (2.8 + rng() * 0.7)));
  const periodKeys = demoPeriodKeysForDate(now);

  return {
    overview: {
      revenue: {
        today: todayRaw,
        thisWeek: weekRaw,
        thisMonth: monthRaw,
        selectedRange: selectedRangeRevenue,
        periodKeys,
      },
      eventCounts: {
        page_view: pageView,
        add_to_cart: addToCart,
        checkout_started: checkoutStarted,
        remove_from_cart: removeFromCart,
        purchase,
      },
      conversionRate: Number(((purchase / pageView) * 100).toFixed(2)),
      audience: {
        uniqueVisitors,
        distinctPurchasers: purchase,
        sessionsWithCartNoPurchase,
      },
    },
    topProducts: Array.from({ length: profile.topProductSlots }, (_, i) => {
      const id = `prod_${String(i + 1).padStart(3, "0")}`;
      const productWeight = 1 - i * (0.07 + (storeId === "store_003" ? 0.04 : 0));
      return {
        product_id: id,
        name: DEMO_PRODUCT_NAMES[id] ?? id,
        revenue: Math.max(
          storeId === "store_003" ? 42 : 180,
          Math.round(
            selectedRangeRevenue *
              (storeId === "store_003" ? 0.22 : 0.12) *
              productWeight *
              (0.78 + rng() * 0.28),
          ),
        ),
      };
    }),
    recentActivity,
    liveVisitors: {
      activeVisitors: Math.min(
        2200,
        Math.max(
          0,
          Math.round(
            profile.liveVisitorsBase + purchase * 0.7 + addToCart * 0.08 + rng() * 12,
          ),
        ),
      ),
      windowMinutes: 5,
    },
    salesTrend: Array.from({ length: 10 }, (_, i) => ({
      bucket: new Date(
        now.getTime() - (9 - i) * 24 * 60 * 60 * 1000,
      ).toISOString(),
      revenue: Math.max(
        80,
        Math.round(
          profile.trendBase *
            (0.86 + i * profile.trendSlope + ((i + 1) % 7 === 0 ? -0.15 : 0) + rng() * 0.08),
        ),
      ),
      purchases: Math.max(
        1,
        Math.round(
          profile.trendBase * profile.purchaseRate * (0.72 + i * 0.032 + rng() * 0.08),
        ),
      ),
    })),
    funnel: {
      steps: [
        { stage: "page_view", count: pageView, dropOffPct: null },
        {
          stage: "add_to_cart",
          count: addToCart,
          dropOffPct: Number(
            (((pageView - addToCart) / pageView) * 100).toFixed(2),
          ),
        },
        {
          stage: "checkout_started",
          count: checkoutStarted,
          dropOffPct: Number(
            (((addToCart - checkoutStarted) / addToCart) * 100).toFixed(2),
          ),
        },
        {
          stage: "remove_from_cart",
          count: removeFromCart,
          dropOffPct: Number(
            (
              ((checkoutStarted - removeFromCart) / checkoutStarted) *
              100
            ).toFixed(2),
          ),
        },
        {
          stage: "purchase",
          count: purchase,
          dropOffPct: Number(
            (((removeFromCart - purchase) / removeFromCart) * 100).toFixed(2),
          ),
        },
      ],
    },
  };
}

function persistIfLive(
  storeId: string | undefined,
  startYmd: string,
  endYmd: string,
  snapshot: DashboardState,
  isDemo: boolean,
  isPlaceholder: boolean,
) {
  if (!storeId || isDemo || isPlaceholder) {
    return;
  }
  writeDashboardCache(storeId, startYmd, endYmd, snapshot);
}

export function Dashboard() {
  const [data, setData] = useState<DashboardState>(() =>
    normalizeDashboardState(
      buildDemoDashboardData({
        deterministic: true,
        storeId: getOwnerSession()?.storeId ?? "store_001",
      }),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState(false);
  /** True until we apply cached or live API data (shell is structural preview only). */
  const [isPlaceholder, setIsPlaceholder] = useState(true);
  /** Date range changed and the next successful fetch has not arrived yet. */
  const [awaitingRangeSync, setAwaitingRangeSync] = useState(false);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return localDateKey(d);
  });
  const [endDate, setEndDate] = useState(() => localDateKey(new Date()));
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [ownerName, setOwnerName] = useState<string>("Store Owner");
  const [ownerStore, setOwnerStore] = useState<string>("");
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  /** Successful live API round-trips (increments each poll) so you can see refresh activity. */
  const [liveSyncCount, setLiveSyncCount] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rangeEffectPrimedRef = useRef(false);
  /** Bumps only when the user actually changes the date range (not on mount / Strict Mode), so fetches are not discarded spuriously. */
  const rangeEpochRef = useRef(0);
  const prevRangeKeyRef = useRef<string | null>(null);
  /** Only one dashboard fetch at a time; extra ticks set `trailing` and run again after (fixes slow API + 1s interval). */
  const refreshMutexRef = useRef({ locked: false, trailing: false });
  const hasLiveSnapshotRef = useRef(false);
  /** Latest fetch implementation without stale closures on trailing refresh. */
  const fetchDashboardRef = useRef<() => Promise<void>>(async () => {});
  const demoRngRef = useRef<(() => number) | null>(null);
  if (demoRngRef.current === null) {
    demoRngRef.current = mulberry32(Math.floor(Math.random() * 0x1fffffff));
  }
  const calendarRevenuePeakRef = useRef({
    dayKey: null as string | null,
    weekKey: null as string | null,
    monthKey: null as string | null,
    today: 0,
    thisWeek: 0,
    thisMonth: 0,
  });
  const [smoothLiveVisitors, setSmoothLiveVisitors] = useState<number | null>(
    null,
  );

  useEffect(() => {
    const key = `${startDate}|${endDate}`;
    if (prevRangeKeyRef.current === null) {
      prevRangeKeyRef.current = key;
      return;
    }
    if (prevRangeKeyRef.current === key) {
      return;
    }
    prevRangeKeyRef.current = key;
    rangeEpochRef.current += 1;
  }, [startDate, endDate]);

  const runDashboardFetch = useCallback(async () => {
    if (!hasAuthSession()) {
      window.location.assign("/login");
      return;
    }

    const epochAtStart = rangeEpochRef.current;

    try {
      setError(null);
      setIsDemoMode(false);
      const result = normalizeDashboardState(
        await fetchDashboard(rangeToApiIso(startDate, endDate)),
      );
      setIsPlaceholder(false);
      if (epochAtStart !== rangeEpochRef.current) {
        return;
      }
      setData(result);
      setAwaitingRangeSync(false);
      setLastSyncedAt(new Date());
      setLiveSyncCount((c) => c + 1);
      hasLiveSnapshotRef.current = true;
      const o = getOwnerSession();
      persistIfLive(o?.storeId, startDate, endDate, result, false, false);
    } catch (err) {
      if (epochAtStart !== rangeEpochRef.current) {
        setIsPlaceholder(false);
        return;
      }
      if (err instanceof Error && err.message === "AUTH_REQUIRED") {
        clearAuthSession();
        window.location.assign("/login");
        return;
      }

      if (!hasLiveSnapshotRef.current) {
        const owner = getOwnerSession();
        setError(
          err instanceof Error
            ? `${err.message} (showing demo data until the API responds.)`
            : "Live API unavailable, showing demo dashboard mode.",
        );
        setData(
          normalizeDashboardState(
            buildDemoDashboardData({
              random: demoRngRef.current!,
              storeId: (owner?.storeId ?? ownerStore) || "store_001",
            }),
          ),
        );
        setIsDemoMode(true);
        setIsPlaceholder(false);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Could not refresh metrics. Still showing your last successful load.",
        );
      }
      setAwaitingRangeSync(false);
    }
  }, [startDate, endDate]);

  /** Keep ref in sync during render so the first `useEffect` poll never calls a no-op closure. */
  fetchDashboardRef.current = runDashboardFetch;

  const load = useCallback(() => {
    const m = refreshMutexRef.current;
    if (m.locked) {
      m.trailing = true;
      return;
    }

    (async () => {
      m.locked = true;
      try {
        await fetchDashboardRef.current();
      } finally {
        m.locked = false;
        if (m.trailing) {
          m.trailing = false;
          load();
        }
      }
    })();
  }, []);

  const applyPreset = (days: number) => {
    const now = new Date();
    const start = new Date();
    start.setDate(now.getDate() - days);
    setStartDate(localDateKey(start));
    setEndDate(localDateKey(now));
  };

  useLayoutEffect(() => {
    if (!hasAuthSession()) {
      window.location.assign("/login");
      return;
    }
    const owner = getOwnerSession();
    if (owner) {
      setOwnerName(owner.name);
      setOwnerStore(owner.storeId);
    }
    const storeId = owner?.storeId;
    if (!storeId) {
      return;
    }
    const cached = readDashboardCache(storeId, startDate, endDate);
    if (cached) {
      setData(normalizeDashboardState(cached));
      setIsPlaceholder(false);
      setError(null);
      setIsDemoMode(false);
    } else {
      setData(
        normalizeDashboardState(
          buildDemoDashboardData({ deterministic: true, storeId }),
        ),
      );
    }
  }, [startDate, endDate]);

  /** Fire a fetch right after layout (with ref already synced) so we never rely on effect ordering alone. */
  useLayoutEffect(() => {
    if (!hasAuthSession()) {
      return;
    }
    queueMicrotask(() => {
      load();
    });
  }, [startDate, endDate, load]);

  useEffect(() => {
    const owner = getOwnerSession();
    if (owner) {
      setOwnerName(owner.name);
      setOwnerStore(owner.storeId);
    }

    if (!autoRefresh) {
      load();
    }
  }, [startDate, endDate, autoRefresh, load]);

  useEffect(() => {
    if (!rangeEffectPrimedRef.current) {
      rangeEffectPrimedRef.current = true;
      return;
    }
    setAwaitingRangeSync(true);
  }, [startDate, endDate]);

  useEffect(() => {
    if (!autoRefresh) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    if (!hasAuthSession()) {
      window.location.assign("/login");
      return;
    }

    load();
    pollTimerRef.current = setInterval(() => load(), DASHBOARD_POLL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [autoRefresh, startDate, endDate, load]);

  const prevDemoModeRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevDemoModeRef.current;
    prevDemoModeRef.current = isDemoMode;
    if (prev === null || prev === isDemoMode) {
      return;
    }
    calendarRevenuePeakRef.current = {
      dayKey: null,
      weekKey: null,
      monthKey: null,
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
    };
    setSmoothLiveVisitors(null);
  }, [isDemoMode]);

  const displayCalendarRevenue = useMemo(() => {
    const rev = data.overview.revenue;
    const keys = rev.periodKeys;
    if (
      !keys ||
      typeof keys.today !== "string" ||
      typeof keys.week !== "string" ||
      typeof keys.month !== "string" ||
      !keys.today ||
      !keys.week ||
      !keys.month
    ) {
      return {
        today: rev.today,
        thisWeek: rev.thisWeek,
        thisMonth: rev.thisMonth,
      };
    }
    const p = calendarRevenuePeakRef.current;
    if (p.dayKey !== keys.today) {
      p.dayKey = keys.today;
      p.today = rev.today;
    } else {
      p.today = Math.max(p.today, rev.today);
    }
    if (p.weekKey !== keys.week) {
      p.weekKey = keys.week;
      p.thisWeek = rev.thisWeek;
    } else {
      p.thisWeek = Math.max(p.thisWeek, rev.thisWeek);
    }
    if (p.monthKey !== keys.month) {
      p.monthKey = keys.month;
      p.thisMonth = rev.thisMonth;
    } else {
      p.thisMonth = Math.max(p.thisMonth, rev.thisMonth);
    }
    return { today: p.today, thisWeek: p.thisWeek, thisMonth: p.thisMonth };
  }, [data.overview.revenue]);

  useEffect(() => {
    if (isPlaceholder) {
      return;
    }
    const raw = data.liveVisitors.activeVisitors;
    if (isDemoMode) {
      setSmoothLiveVisitors(raw);
      return;
    }
    setSmoothLiveVisitors((prev) => {
      if (prev === null) {
        return raw;
      }
      const eased = Math.round(prev * 0.72 + raw * 0.28);
      const maxStep = Math.max(2, Math.round(prev * 0.12));
      const delta = eased - prev;
      const clampedDelta = Math.max(-maxStep, Math.min(maxStep, delta));
      return prev + clampedDelta;
    });
  }, [data.liveVisitors.activeVisitors, isDemoMode, isPlaceholder]);

  const liveVisitorsDisplay =
    smoothLiveVisitors === null
      ? data.liveVisitors.activeVisitors
      : smoothLiveVisitors;

  const maxRevenue = useMemo(() => {
    if (!data?.topProducts.length) return 1;
    return Math.max(...data.topProducts.map((item) => item.revenue), 1);
  }, [data]);

  const topEventType = useMemo(() => {
    if (!data) {
      return "none";
    }

    return (
      FUNNEL_EVENT_ORDER.map(
        (k) => [k, data.overview.eventCounts[k] ?? 0] as const,
      ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none"
    );
  }, [data]);

  return (
    <div
      className="flex min-h-screen flex-col bg-background"
      aria-busy={isPlaceholder}
    >
      <header className="flex h-12 shrink-0 items-center justify-between bg-accent px-5 text-white shadow-sm">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium tracking-wide">
            Dashboard
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span>
            {ownerName} {ownerStore ? `(${ownerStore})` : ""}
          </span>
          <button
            className="text-white/80 transition-colors hover:text-white"
            onClick={async () => {
              try {
                await logoutOwner();
              } catch {}
              clearAuthSession();
              clearDashboardCache();
              window.location.assign("/login");
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="shrink-0 border-b border-border bg-white px-5 py-3">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-medium text-foreground">Dashboard</h1>
              {isDemoMode && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                  Demo
                </span>
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              {lastSyncedAt ? (
                <span>
                  Last synced {formatSyncedClock(lastSyncedAt)}
                  {!isDemoMode && !isPlaceholder ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · live fetch #{liveSyncCount}
                    </span>
                  ) : null}
                </span>
              ) : (
                "Syncing..."
              )}
              {!isDemoMode && autoRefresh && !isPlaceholder ? (
                <span className="text-muted-foreground">
                  · polling every {DASHBOARD_POLL_MS / 1000}s (check Nest terminal for
                  GET /analytics/dashboard)
                </span>
              ) : null}
              {!isDemoMode && !autoRefresh && !isPlaceholder ? (
                <span className="text-amber-800">
                  · auto-refresh off — backend only logs when you click Refresh
                </span>
              ) : null}
              {isDemoMode ? (
                <span className="text-amber-800">
                  · demo data — fix API connection to hit the real backend
                </span>
              ) : null}
              {error && <span className="text-red-500">• {error}</span>}
              {awaitingRangeSync && !isPlaceholder && (
                <span>• Updating charts...</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-8 items-center overflow-hidden rounded-sm border border-border bg-white text-sm shadow-sm">
              <button
                onClick={() => applyPreset(0)}
                className="h-full px-3 transition-colors hover:bg-slate-50"
              >
                Today
              </button>
              <div className="h-full w-px bg-border" />
              <button
                onClick={() => applyPreset(7)}
                className="h-full px-3 transition-colors hover:bg-slate-50"
              >
                7d
              </button>
              <div className="h-full w-px bg-border" />
              <button
                onClick={() => applyPreset(30)}
                className="h-full px-3 transition-colors hover:bg-slate-50"
              >
                30d
              </button>
            </div>
            <div className="flex h-8 items-center overflow-hidden rounded-sm border border-border bg-white px-2 text-sm shadow-sm">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-transparent text-muted-foreground outline-none"
              />
              <span className="mx-2 text-muted">-</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-transparent text-muted-foreground outline-none"
              />
            </div>
            <div className="flex h-8 items-center gap-2">
              <Button
                variant="ghost"
                className="h-full border border-border bg-white px-3 text-xs shadow-sm hover:bg-slate-50"
                onClick={() => setAutoRefresh((prev) => !prev)}
              >
                <Activity className="mr-2 h-3.5 w-3.5 text-blue-600" />
                {autoRefresh ? "Watching" : "Paused"}
              </Button>
              <Button
                onClick={load}
                type="button"
                className="h-full px-3 text-xs shadow-sm"
                disabled={isPlaceholder && !isDemoMode}
              >
                <RefreshCw
                  className={`mr-2 h-3.5 w-3.5 ${isPlaceholder && !isDemoMode ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-4 p-5">
        <section className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <MetricCard
            title="Revenue Today"
            value={currency(displayCalendarRevenue.today)}
            subtitle="Calendar day (Store TZ)"
          />
          <MetricCard
            title="Revenue This Week"
            value={currency(displayCalendarRevenue.thisWeek)}
            subtitle="ISO week (Store TZ)"
          />
          <MetricCard
            title="Revenue This Month"
            value={currency(displayCalendarRevenue.thisMonth)}
            subtitle="Calendar month (Store TZ)"
          />
          <MetricCard
            title="Revenue (Range)"
            value={currency(data.overview.revenue.selectedRange ?? 0)}
            subtitle="Sum in selected dates"
          />
          <MetricCard
            title="Conversion Rate"
            value={pct(data.overview.conversionRate)}
            subtitle="Purchaser sessions / visitor sessions"
          />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-muted">
                <Activity className="h-3.5 w-3.5 text-green-500" />
                Live Visitors
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end justify-between">
                <p className="text-3xl font-semibold leading-none">
                  {formatIntegerCount(liveVisitorsDisplay)}
                </p>
                <span className="text-xs text-muted-foreground">
                  Last {data.liveVisitors.windowMinutes}m
                </span>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          <MetricCard
            title="Unique Visitors"
            value={formatIntegerCount(data.overview.audience.uniqueVisitors)}
            subtitle="Distinct sessions with PVs"
          />
          <MetricCard
            title="Distinct Purchasers"
            value={formatIntegerCount(data.overview.audience.distinctPurchasers)}
            subtitle="Sessions completing purchase"
          />
          <MetricCard
            title="Abandoned Carts"
            value={formatIntegerCount(data.overview.audience.sessionsWithCartNoPurchase)}
            subtitle="Sessions with cart, no purchase"
          />
        </section>

        <section className="grid min-w-0 gap-4 xl:grid-cols-5">
          <Card className="min-w-0 xl:col-span-3">
            <CardHeader className="border-b border-border bg-slate-50/50 py-3">
              <CardTitle className="text-sm font-semibold text-foreground">
                Revenue Trend
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px] min-h-[260px] min-w-0 w-full p-4">
              <ResponsiveContainer width="100%" height="100%" debounce={50}>
                <AreaChart data={data.salesTrend}>
                  <defs>
                    <linearGradient
                      id="fillRevenue"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="#0b5cab"
                        stopOpacity={0.25}
                      />
                      <stop
                        offset="95%"
                        stopColor="#0b5cab"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={niceDateLabel}
                    stroke="#64748b"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    stroke="#64748b"
                    tickLine={false}
                    axisLine={false}
                    width={65}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: 4,
                      boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
                    }}
                    labelStyle={{ color: "#0f172a", fontWeight: 500 }}
                    formatter={(value: number) => currency(Number(value))}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#0b5cab"
                    strokeWidth={2}
                    fill="url(#fillRevenue)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="min-w-0 xl:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between border-b border-border bg-slate-50/50 py-3">
              <CardTitle className="text-sm font-semibold text-foreground">
                Event Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px] min-h-[260px] min-w-0 w-full p-4">
              <ResponsiveContainer width="100%" height="100%" debounce={50}>
                <BarChart
                  data={FUNNEL_EVENT_ORDER.map((key) => ({
                    name: FUNNEL_STAGE_LABEL[key],
                    count: data.overview.eventCounts[key] ?? 0,
                  }))}
                  margin={{ bottom: 16, left: 0, right: 8, top: 4 }}
                >
                  <CartesianGrid stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="name"
                    stroke="#64748b"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    tick={{ fontSize: 11 }}
                    angle={-25}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    stroke="#64748b"
                    tickLine={false}
                    axisLine={false}
                    width={50}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: 4,
                      boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
                    }}
                    labelStyle={{ color: "#0f172a", fontWeight: 500 }}
                  />
                  <Bar
                    dataKey="count"
                    fill="#475569"
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>

        <section className="grid min-w-0 gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-2">
            <CardHeader className="border-b border-border bg-slate-50/50 py-3">
              <CardTitle className="text-sm font-semibold text-foreground">
                Conversion Funnel
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex flex-col divide-y divide-border">
                {data.funnel.steps.map((step) => (
                  <div
                    key={step.stage}
                    className="flex items-center justify-between p-4 bg-white hover:bg-slate-50/50 transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {FUNNEL_STAGE_LABEL[
                          step.stage as keyof typeof FUNNEL_STAGE_LABEL
                        ] ?? step.stage.replaceAll("_", " ")}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {step.dropOffPct !== null
                          ? `Drop-off: ${step.dropOffPct.toFixed(1)}%`
                          : "Entry stage"}
                      </p>
                    </div>
                    <span className="font-semibold text-foreground">
                      {formatIntegerCount(step.count)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="xl:col-span-3">
            <CardHeader className="border-b border-border bg-slate-50/50 py-3">
              <CardTitle className="text-sm font-semibold text-foreground">
                Top Products
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex flex-col divide-y divide-border">
                {data.topProducts.map((item) => (
                  <div
                    key={item.product_id}
                    className="p-4 bg-white hover:bg-slate-50/50 transition-colors"
                  >
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground truncate pl-1">
                        {item.name}
                      </span>
                      <span className="font-semibold">
                        {currency(item.revenue)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-sm bg-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-slate-400"
                        style={{
                          width: `${Math.max(1, Math.round((item.revenue / maxRevenue) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader className="border-b border-border bg-slate-50/50 py-3">
            <CardTitle className="text-sm font-semibold text-foreground">
              Recent Activity
            </CardTitle>
            <CardDescription className="text-xs">
              {isDemoMode
                ? "Synthetic events while the API is unavailable."
                : lastSyncedAt
                  ? `Rows reflect your DB at last sync (${formatSyncedClock(lastSyncedAt)}). New events appear after ingest + refresh.`
                  : "Loading activity from the API…"}
            </CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-50/80 text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Event</th>
                  <th className="px-4 py-2.5 font-medium">Product ID</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-white">
                {data.recentActivity.map((event) => (
                  <tr
                    key={event.eventId}
                    className="hover:bg-slate-50/50 transition-colors"
                  >
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {formatActivityTime(event.timestamp)}
                    </td>
                    <td className="px-4 py-2.5 font-medium capitalize text-foreground">
                      {event.eventType.replaceAll("_", " ")}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {event.data.productId || "-"}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-foreground">
                      {event.data.amount != null
                        ? `${currency(event.data.amount)}${event.data.currency ? ` ${event.data.currency}` : ""}`
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </main>
    </div>
  );
}
