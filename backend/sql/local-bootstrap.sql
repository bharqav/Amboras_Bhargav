-- Local bootstrap SQL (no Supabase required)
-- Usage examples:
--   psql "postgresql://postgres:postgres@localhost:5432/amboras" -f backend/sql/local-bootstrap.sql
--   OR run backend scripts: npm run db:init --prefix backend && npm run db:seed --prefix backend

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'add_to_cart', 'remove_from_cart', 'checkout_started', 'purchase')),
  timestamp TIMESTAMPTZ NOT NULL,
  session_id TEXT,
  product_id TEXT,
  amount NUMERIC(12, 2),
  currency TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_store_timestamp
  ON analytics_events (store_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_events_store_type
  ON analytics_events (store_id, event_type);

CREATE INDEX IF NOT EXISTS idx_events_store_purchase_product
  ON analytics_events (store_id, product_id)
  WHERE event_type = 'purchase';

CREATE INDEX IF NOT EXISTS idx_events_live_visitors
  ON analytics_events (store_id, timestamp DESC, session_id)
  WHERE event_type = 'page_view';

CREATE INDEX IF NOT EXISTS idx_events_store_purchase_timestamp_product
  ON analytics_events (store_id, timestamp DESC, product_id)
  WHERE event_type = 'purchase' AND product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_store_event_timestamp
  ON analytics_events (store_id, event_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_events_store_session_timestamp
  ON analytics_events (store_id, session_id, timestamp DESC)
  WHERE session_id IS NOT NULL;

-- Minimal starter rows for all stores (safe to rerun)
INSERT INTO analytics_events (event_id, store_id, event_type, timestamp, session_id, product_id, amount, currency)
VALUES
  ('evt_boot_001', 'store_001', 'page_view', now() - interval '5 minutes', 'store_001_sess_00001', 'prod_001', NULL, NULL),
  ('evt_boot_002', 'store_001', 'add_to_cart', now() - interval '4 minutes', 'store_001_sess_00001', 'prod_001', NULL, NULL),
  ('evt_boot_003', 'store_001', 'checkout_started', now() - interval '3 minutes', 'store_001_sess_00001', 'prod_001', NULL, NULL),
  ('evt_boot_004', 'store_001', 'purchase', now() - interval '2 minutes', 'store_001_sess_00001', 'prod_001', 89.00, 'USD'),

  ('evt_boot_005', 'store_002', 'page_view', now() - interval '10 minutes', 'store_002_sess_00001', 'prod_004', NULL, NULL),
  ('evt_boot_006', 'store_002', 'add_to_cart', now() - interval '8 minutes', 'store_002_sess_00001', 'prod_004', NULL, NULL),
  ('evt_boot_007', 'store_002', 'purchase', now() - interval '6 minutes', 'store_002_sess_00001', 'prod_004', 71.00, 'USD'),

  ('evt_boot_008', 'store_003', 'page_view', now() - interval '16 minutes', 'store_003_sess_00001', 'prod_010', NULL, NULL),
  ('evt_boot_009', 'store_003', 'add_to_cart', now() - interval '14 minutes', 'store_003_sess_00001', 'prod_010', NULL, NULL),
  ('evt_boot_010', 'store_003', 'remove_from_cart', now() - interval '12 minutes', 'store_003_sess_00001', 'prod_010', NULL, NULL)
ON CONFLICT (event_id) DO NOTHING;
