import { type OwnerSession, getSessionAccessToken } from './auth';

export type AudienceMetrics = {
  uniqueVisitors: number;
  distinctPurchasers: number;
  sessionsWithCartNoPurchase: number;
};

export type RevenuePeriodKeys = {
  /** Calendar date YYYY-MM-DD in store timezone (resets revenue “today” at 00:00). */
  today: string;
  /** ISO week start Monday YYYY-MM-DD in store timezone (resets at Mon 00:00). */
  week: string;
  /** Calendar month YYYY-MM in store timezone (resets on the 1st). */
  month: string;
};

export type OverviewResponse = {
  revenue: {
    today: number;
    thisWeek: number;
    thisMonth: number;
    selectedRange: number;
    /** Present from API v6+; used client-side to reset monotonic caps at calendar boundaries. */
    periodKeys?: RevenuePeriodKeys;
  };
  eventCounts: Record<string, number>;
  conversionRate: number;
  audience: AudienceMetrics;
};

export type TopProductsResponse = Array<{ product_id: string; name: string; revenue: number }>;

export type RecentActivityResponse = Array<{
  eventId: string;
  storeId: string;
  eventType: string;
  timestamp: string;
  data: {
    productId: string | null;
    amount: number | null;
    currency: string | null;
  };
}>;

export type DashboardFilters = {
  startDate?: string;
  endDate?: string;
};

export type LiveVisitorsResponse = {
  activeVisitors: number;
  windowMinutes: number;
};

export type SalesTrendResponse = Array<{
  bucket: string;
  revenue: number;
  purchases: number;
}>;

export type FunnelResponse = {
  steps: Array<{
    stage: string;
    count: number;
    dropOffPct: number | null;
  }>;
};

export type DashboardData = {
  overview: OverviewResponse;
  topProducts: TopProductsResponse;
  recentActivity: RecentActivityResponse;
  liveVisitors: LiveVisitorsResponse;
  salesTrend: SalesTrendResponse;
  funnel: FunnelResponse;
};

export type LoginResponse = {
  owner: OwnerSession;
  /** Same JWT as httpOnly cookie; use for EventSource when cookies are not sent cross-origin. */
  accessToken: string;
};

export type DemoOwner = {
  email: string;
  storeId: string;
  name: string;
};

/**
 * Browser: same-origin `/api/v1` → `app/api/v1/[...path]/route.ts` proxies to Nest.
 * Server (SSR): full backend URL from env.
 */
function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return '/api/v1';
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000/api/v1';
}

/** Avoid hanging forever on a stuck DB/Redis/network; keeps UI from “Syncing…” indefinitely. */
const REQUEST_TIMEOUT_MS = 120_000;

function networkErrorMessage(): string {
  return `Cannot reach API at ${getApiBaseUrl()}. Start the backend (e.g. cd backend && npm run start:dev), check PORT matches this URL, and ensure CORS allows this page’s origin.`;
}

async function fetchApi(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — ${input}. The backend may be overloaded or waiting on the database.`,
      );
    }
    throw new Error(networkErrorMessage());
  } finally {
    clearTimeout(timer);
  }
}

function withQuery(path: string, filters?: DashboardFilters, extra?: Record<string, string | number>) {
  const params = new URLSearchParams();

  if (filters?.startDate) {
    params.set('startDate', filters.startDate);
  }

  if (filters?.endDate) {
    params.set('endDate', filters.endDate);
  }

  if (extra) {
    Object.entries(extra).forEach(([key, value]) => params.set(key, String(value)));
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function bearerInit(): RequestInit {
  if (typeof window === 'undefined') {
    return {};
  }
  const token = getSessionAccessToken();
  if (!token) {
    return {};
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function request<T>(path: string): Promise<T> {
  const response = await fetchApi(`${getApiBaseUrl()}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...bearerInit(),
  });

  if (response.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }

  if (!response.ok) {
    const snippet = await response.text().catch(() => '');
    throw new Error(
      `Failed request: ${path} (HTTP ${response.status})${snippet ? ` — ${snippet.slice(0, 240)}` : ''}`,
    );
  }

  return response.json() as Promise<T>;
}

export async function fetchDashboard(filters?: DashboardFilters): Promise<DashboardData> {
  return request<DashboardData>(withQuery('/analytics/dashboard', filters));
}

export async function loginOwner(email: string, password: string): Promise<LoginResponse> {
  const response = await fetchApi(`${getApiBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('Invalid email or password');
  }

  return response.json() as Promise<LoginResponse>;
}

export async function logoutOwner(): Promise<void> {
  await fetchApi(`${getApiBaseUrl()}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    ...bearerInit(),
  });
}

export async function fetchDemoOwners(): Promise<DemoOwner[]> {
  const response = await fetchApi(`${getApiBaseUrl()}/auth/demo-owners`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Could not load demo owners');
  }
  return response.json() as Promise<DemoOwner[]>;
}
