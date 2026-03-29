/* eslint-disable no-console */
require('./load-env')();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const ALL_STORES = ['store_001', 'store_002', 'store_003'];
const PRODUCTS = Array.from({ length: 25 }, (_, i) => `prod_${String(i + 1).padStart(3, '0')}`);

const fixedStoreId = process.env.STORE_ID?.trim();
const STORES = fixedStoreId ? [fixedStoreId] : ALL_STORES;

/** Live simulator: flagship ~50–60 purchases/min, mid ~20, new store ~3–4. */
const DEFAULT_STORE_PROFILE = {
  store_001: { purchasesPerMinute: 56, avgOrderValue: 126, sessionPool: 5200 },
  store_002: { purchasesPerMinute: 20, avgOrderValue: 86, sessionPool: 2800 },
  store_003: { purchasesPerMinute: 3.5, avgOrderValue: 61, sessionPool: 1100 },
};

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function profileForStore(storeId) {
  const base = DEFAULT_STORE_PROFILE[storeId] ?? {
    purchasesPerMinute: 12,
    avgOrderValue: 80,
    sessionPool: 1800,
  };
  const envKey = storeId.toUpperCase();
  const globalPpm = process.env.PURCHASES_PER_MINUTE;
  return {
    purchasesPerMinute: Math.max(
      0,
      numEnv(`${envKey}_PURCHASES_PER_MINUTE`, globalPpm ? numEnv('PURCHASES_PER_MINUTE', base.purchasesPerMinute) : base.purchasesPerMinute),
    ),
    avgOrderValue: Math.max(10, numEnv(`${envKey}_AVG_ORDER_VALUE`, base.avgOrderValue)),
    sessionPool: Math.max(400, Math.floor(numEnv(`${envKey}_SESSION_POOL`, base.sessionPool))),
  };
}

const STORE_PROFILE = Object.fromEntries(STORES.map((storeId) => [storeId, profileForStore(storeId)]));

const SESSIONS_BY_STORE = Object.fromEntries(
  STORES.map((store) => [
    store,
    Array.from({ length: STORE_PROFILE[store].sessionPool }, (_, i) => `${store}_sess_${String(i + 1).padStart(5, '0')}`),
  ]),
);

const purchaseAccByStore = Object.fromEntries(STORES.map((store) => [store, 0]));
const recentPvSessionsByStore = Object.fromEntries(STORES.map((store) => [store, []]));
const rollingPurchaseBuckets = Object.fromEntries(STORES.map((store) => [store, []]));

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTimestampNearNow() {
  const now = Date.now();
  // Keep events close to wall-clock time so the dashboard visibly advances.
  return new Date(now - Math.floor(Math.random() * 1100));
}

function countFromRatePerMinute(storeId) {
  const perSecond = STORE_PROFILE[storeId].purchasesPerMinute / 60;
  purchaseAccByStore[storeId] += perSecond;
  const whole = Math.floor(purchaseAccByStore[storeId]);
  purchaseAccByStore[storeId] -= whole;
  return whole;
}

function boundedInt(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function buildEvent(eventType, storeId, index, batchOffset, preferredSessionId = null) {
  const timestamp = randomTimestampNearNow();
  const sessionId = preferredSessionId || pick(SESSIONS_BY_STORE[storeId]);
  const p = pick(PRODUCTS);
  const p2 = pick(PRODUCTS);

  let productId = null;
  let amount = null;
  let currency = null;

  switch (eventType) {
    case 'purchase':
      productId = p;
      amount = (STORE_PROFILE[storeId].avgOrderValue * (0.58 + Math.random() * 0.95)).toFixed(2);
      currency = 'USD';
      break;
    case 'add_to_cart':
    case 'remove_from_cart':
      productId = Math.random() > 0.06 ? p : p2;
      break;
    case 'checkout_started':
      productId = Math.random() > 0.12 ? p : null;
      break;
    default:
      productId = Math.random() > 0.42 ? p : null;
  }

  const eventId = `evt_${randomUUID()}_${batchOffset}_${index}`;

  return {
    eventId,
    storeId,
    eventType,
    timestamp,
    sessionId,
    productId,
    amount,
    currency,
  };
}

function buildStoreEventsForSecond(storeId, offset, secondIndex) {
  const purchases = countFromRatePerMinute(storeId);

  const baseViews = Math.max(1, Math.round(STORE_PROFILE[storeId].purchasesPerMinute * 0.85 / 60));
  const pageViews = baseViews + purchases * boundedInt(4, 6) + boundedInt(0, 3);
  const addToCart = Math.max(purchases, Math.round(pageViews * (0.21 + Math.random() * 0.06)));
  const checkoutStarted = Math.max(purchases, Math.round(addToCart * (0.5 + Math.random() * 0.1)));
  const removeFromCart = Math.max(purchases, Math.round(checkoutStarted * (0.62 + Math.random() * 0.1)));

  const events = [];
  let rowOffset = 0;
  const tickPvSessions = [];

  for (let i = 0; i < pageViews; i += 1) {
    const ev = buildEvent('page_view', storeId, i, `${offset}_${secondIndex}_${rowOffset}`);
    events.push(ev);
    tickPvSessions.push(ev.sessionId);
    rowOffset += 1;
  }

  const recent = recentPvSessionsByStore[storeId];
  recent.push(...tickPvSessions);
  if (recent.length > 6000) {
    recent.splice(0, recent.length - 6000);
  }

  for (let i = 0; i < addToCart; i += 1) {
    events.push(buildEvent('add_to_cart', storeId, i, `${offset}_${secondIndex}_${rowOffset}`));
    rowOffset += 1;
  }
  for (let i = 0; i < checkoutStarted; i += 1) {
    events.push(buildEvent('checkout_started', storeId, i, `${offset}_${secondIndex}_${rowOffset}`));
    rowOffset += 1;
  }
  for (let i = 0; i < removeFromCart; i += 1) {
    events.push(buildEvent('remove_from_cart', storeId, i, `${offset}_${secondIndex}_${rowOffset}`));
    rowOffset += 1;
  }
  for (let i = 0; i < purchases; i += 1) {
    const preferred = recent.length > 0 && Math.random() < 0.9 ? pick(recent) : null;
    events.push(buildEvent('purchase', storeId, i, `${offset}_${secondIndex}_${rowOffset}`, preferred));
    rowOffset += 1;
  }

  rollingPurchaseBuckets[storeId].push(purchases);
  if (rollingPurchaseBuckets[storeId].length > 60) {
    rollingPurchaseBuckets[storeId].shift();
  }

  return events;
}

async function insertBatch(pool, events) {
  if (events.length === 0) {
    return;
  }

  const values = [];
  const placeholders = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const base = i * 8;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
    values.push(
      event.eventId,
      event.storeId,
      event.eventType,
      event.timestamp,
      event.sessionId,
      event.productId,
      event.amount,
      event.currency,
    );
  }

  await pool.query(
    `
    INSERT INTO analytics_events (event_id, store_id, event_type, timestamp, session_id, product_id, amount, currency)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (event_id) DO NOTHING
    `,
    values,
  );
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const durationSeconds = Number(process.env.DURATION_SECONDS || '3600');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

  const modeLabel = fixedStoreId ? `store ${fixedStoreId}` : 'mixed tiered stores';
  console.log(`Starting stream simulation (${modeLabel}) for ${durationSeconds}s`);
  STORES.forEach((storeId) => {
    const p = STORE_PROFILE[storeId];
    console.log(
      `  ${storeId}: target purchases/min=${p.purchasesPerMinute}, avg_order_value~$${p.avgOrderValue.toFixed(2)}, sessions=${p.sessionPool}`,
    );
  });

  let totalInserted = 0;
  const startedAt = Date.now();

  for (let second = 0; second < durationSeconds; second += 1) {
    const tickStart = Date.now();
    const batchEvents = [];
    for (const storeId of STORES) {
      batchEvents.push(...buildStoreEventsForSecond(storeId, totalInserted, second));
    }

    await insertBatch(pool, batchEvents);
    totalInserted += batchEvents.length;

    if (second > 0 && second % 15 === 0) {
      const status = STORES.map((storeId) => {
        const window = rollingPurchaseBuckets[storeId];
        const sum = window.reduce((acc, n) => acc + n, 0);
        return `${storeId}:${sum}/min`;
      }).join(' | ');
      console.log(`tick=${second}s events=${totalInserted} rolling_purchases ${status}`);
    }

    const elapsed = Date.now() - tickStart;
    const sleepMs = Math.max(0, 1000 - elapsed);
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  const totalDurationSec = (Date.now() - startedAt) / 1000;
  const achievedEventsPerMinute = Math.round((totalInserted / totalDurationSec) * 60);
  const achievedStorePurchases = STORES.map((storeId) => {
    const sum = rollingPurchaseBuckets[storeId].reduce((acc, n) => acc + n, 0);
    return `${storeId}:${sum}/min`;
  }).join(' | ');

  console.log(`Inserted ${totalInserted} events in ${totalDurationSec.toFixed(1)}s (~${achievedEventsPerMinute}/min events)`);
  console.log(`Final rolling purchase rates: ${achievedStorePurchases}`);

  await pool.end();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
