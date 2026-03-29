import type { DashboardData } from './api';

const KEY = 'amboras_dashboard_v2';
/** Older builds; remove so users are not stuck on a frozen snapshot. */
const LEGACY_KEYS = ['amboras_dashboard_v1'];

type Payload = {
  version: 2;
  storeId: string;
  startDate: string;
  endDate: string;
  savedAt: number;
  data: DashboardData;
};

function dropLegacyDashboardKeys() {
  for (const k of LEGACY_KEYS) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export function readDashboardCache(storeId: string, startDate: string, endDate: string): DashboardData | null {
  if (typeof window === 'undefined') {
    return null;
  }
  dropLegacyDashboardKeys();
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const p = JSON.parse(raw) as Payload;
    if (p.version !== 2 || p.storeId !== storeId || p.startDate !== startDate || p.endDate !== endDate) {
      return null;
    }
    if (!p.data?.overview?.eventCounts) {
      return null;
    }
    return p.data;
  } catch {
    return null;
  }
}

export function writeDashboardCache(storeId: string, startDate: string, endDate: string, data: DashboardData): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const payload: Payload = {
      version: 2,
      storeId,
      startDate,
      endDate,
      savedAt: Date.now(),
      data,
    };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function clearDashboardCache(): void {
  if (typeof window === 'undefined') {
    return;
  }
  dropLegacyDashboardKeys();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
