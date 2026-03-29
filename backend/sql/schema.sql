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

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS session_id TEXT;

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

-- Helps `top-products` aggregations (filtering purchase events by time window)
CREATE INDEX IF NOT EXISTS idx_events_store_purchase_timestamp_product
  ON analytics_events (store_id, timestamp DESC, product_id)
  WHERE event_type = 'purchase' AND product_id IS NOT NULL;

-- Helps `overview` / conversion calculations (grouping counts by event_type over time windows)
CREATE INDEX IF NOT EXISTS idx_events_store_event_timestamp
  ON analytics_events (store_id, event_type, timestamp DESC);

-- Session-scoped analytics (distinct visitors, cart abandonment, tenant-safe joins on session_id)
CREATE INDEX IF NOT EXISTS idx_events_store_session_timestamp
  ON analytics_events (store_id, session_id, timestamp DESC)
  WHERE session_id IS NOT NULL;
