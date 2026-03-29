/* eslint-disable no-console */
require('./load-env')();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { sampleFunnelCounts, multisetFromCounts } = require('./funnel-counts');

const STORES = ['store_001', 'store_002', 'store_003'];

/**
 * Tiered stores: flagship (high volume + long history), mid-market, new launch.
 * Weights control share of SEED_EVENTS; historyDays skew timestamps for “past story”.
 */
const STORE_SEED = {
  store_001: {
    weight: 0.5,
    historyDays: 120,
    sessions: 2800,
    purchaseMin: 48,
    purchaseMax: 210,
  },
  store_002: {
    weight: 0.33,
    historyDays: 72,
    sessions: 1400,
    purchaseMin: 24,
    purchaseMax: 155,
  },
  store_003: {
    weight: 0.17,
    historyDays: 16,
    sessions: 380,
    purchaseMin: 9,
    purchaseMax: 92,
  },
};

const PRODUCTS = Array.from({ length: 25 }, (_, i) => `prod_${String(i + 1).padStart(3, '0')}`);

const SESSIONS_BY_STORE = Object.fromEntries(
  STORES.map((store) => [
    store,
    Array.from({ length: STORE_SEED[store].sessions }, (_, i) => `${store}_sess_${String(i + 1).padStart(5, '0')}`),
  ]),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomTimestampWithinDays(days) {
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  return new Date(now - Math.floor(Math.random() * windowMs));
}

function generateEventWithType(storeId, eventType, index) {
  const cfg = STORE_SEED[storeId];
  const timestamp = randomTimestampWithinDays(cfg.historyDays);
  const sessionId = pick(SESSIONS_BY_STORE[storeId]);
  const p = pick(PRODUCTS);
  const p2 = pick(PRODUCTS);

  let productId = null;
  let amount = null;
  let currency = null;

  switch (eventType) {
    case 'purchase':
      productId = p;
      amount = (cfg.purchaseMin + Math.random() * (cfg.purchaseMax - cfg.purchaseMin)).toFixed(2);
      currency = 'USD';
      break;
    case 'add_to_cart':
    case 'remove_from_cart':
      productId = Math.random() > 0.08 ? p : p2;
      break;
    case 'checkout_started':
      productId = Math.random() > 0.15 ? p : null;
      break;
    default:
      productId = Math.random() > 0.45 ? p : null;
  }

  return {
    eventId: `evt_${Date.now()}_${index}_${randomUUID()}`,
    storeId,
    eventType,
    timestamp,
    sessionId,
    productId,
    amount,
    currency,
  };
}

/** Integer split of batchSize across stores matching STORE_SEED weights (sums exactly to batchSize). */
function splitBatchWeighted(batchSize) {
  const ratios = STORES.map((id) => STORE_SEED[id].weight);
  const sumR = ratios.reduce((a, b) => a + b, 0);
  const raw = ratios.map((r) => Math.floor((batchSize * r) / sumR));
  let used = raw.reduce((a, b) => a + b, 0);
  let rem = batchSize - used;
  let i = 0;
  while (rem > 0) {
    raw[i % STORES.length] += 1;
    rem -= 1;
    i += 1;
  }
  return STORES.map((storeId, idx) => ({ storeId, n: raw[idx] }));
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const totalEvents = Number(process.env.SEED_EVENTS || '120000');
  const batchSize = 5000;

  console.log(`Seeding ${totalEvents} events (tiered stores: flagship / mid / new)...`);
  STORES.forEach((id) => {
    const s = STORE_SEED[id];
    console.log(
      `  ${id}: ~${(s.weight * 100).toFixed(0)}% of rows, last ${s.historyDays}d history, AOV ~$${s.purchaseMin}–${s.purchaseMax}`,
    );
  });

  for (let offset = 0; offset < totalEvents; offset += batchSize) {
    const currentBatch = Math.min(batchSize, totalEvents - offset);
    const values = [];
    const placeholders = [];
    let rowIndex = 0;

    const parts = splitBatchWeighted(currentBatch);
    for (const { storeId, n } of parts) {
      if (n <= 0) continue;
      const counts = sampleFunnelCounts(Math.max(n, 220));
      const bag = shuffleInPlace(multisetFromCounts(counts));
      const take = Math.min(n, bag.length);
      for (let j = 0; j < take; j += 1) {
        const event = generateEventWithType(storeId, bag[j], offset + rowIndex);
        rowIndex += 1;
        const i = values.length / 8;
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
    }

    await pool.query(
      `
      INSERT INTO analytics_events (event_id, store_id, event_type, timestamp, session_id, product_id, amount, currency)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
      `,
      values,
    );

    console.log(`Inserted ${offset + currentBatch}/${totalEvents}`);
  }

  console.log('Seeding complete.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
