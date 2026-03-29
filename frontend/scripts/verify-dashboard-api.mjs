/**
 * End-to-end check: backend login + GET /analytics/dashboard matches what the UI expects
 * (revenue, overview, top products, funnel). Run with API up: same URL as NEXT_PUBLIC_API_BASE_URL.
 *
 * Usage:
 *   set API_BASE_URL=http://localhost:4200/api/v1 && node scripts/verify-dashboard-api.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function apiBaseFromEnvLocal() {
  const p = join(__dirname, '..', '.env.local');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('NEXT_PUBLIC_API_BASE_URL='));
  if (!line) return null;
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') || null;
}

const API_BASE_URL =
  process.env.API_BASE_URL || apiBaseFromEnvLocal() || 'http://localhost:4000/api/v1';

const start = new Date();
start.setDate(start.getDate() - 7);
const end = new Date();
const startDate = start.toISOString();
const endDate = end.toISOString();
const qs = new URLSearchParams({ startDate, endDate }).toString();

async function main() {
  const loginRes = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'owner1@amboras.dev',
      password: 'amboras-store-001',
    }),
  });
  assert.equal(loginRes.ok, true, `login failed ${loginRes.status} — is the backend running at ${API_BASE_URL}?`);

  const loginJson = await loginRes.json();
  const token = loginJson.accessToken;
  assert.ok(token, 'login response missing accessToken');

  const dashRes = await fetch(`${API_BASE_URL}/analytics/dashboard?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashRes.ok, true, `dashboard failed ${dashRes.status}`);

  const data = await dashRes.json();

  assert.ok(data.overview?.revenue, 'missing overview.revenue');
  const r = data.overview.revenue;
  for (const k of ['today', 'thisWeek', 'thisMonth', 'selectedRange']) {
    assert.equal(typeof r[k], 'number', `revenue.${k} should be number`);
    assert.ok(Number.isFinite(r[k]), `revenue.${k} should be finite`);
  }
  assert.ok(r.periodKeys && typeof r.periodKeys === 'object', 'revenue.periodKeys');
  for (const k of ['today', 'week', 'month']) {
    assert.equal(typeof r.periodKeys[k], 'string', `periodKeys.${k}`);
    assert.ok(r.periodKeys[k].length > 0, `periodKeys.${k} non-empty`);
  }

  assert.ok(data.overview?.eventCounts, 'missing eventCounts');
  assert.ok(Array.isArray(data.topProducts) && data.topProducts.length > 0, 'topProducts');
  assert.ok(data.topProducts[0].name && data.topProducts[0].revenue >= 0, 'top product shape');

  assert.ok(Array.isArray(data.funnel?.steps) && data.funnel.steps.length === 5, 'funnel steps');
  assert.ok(Array.isArray(data.salesTrend), 'salesTrend');
  assert.ok(data.liveVisitors?.activeVisitors >= 0, 'liveVisitors');

  console.log(`verify-dashboard-api: ok (${API_BASE_URL})`);
  console.log(
    `  revenue selectedRange=${r.selectedRange} today=${r.today} purchases in funnel last=${data.funnel.steps.at(-1)?.count}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
