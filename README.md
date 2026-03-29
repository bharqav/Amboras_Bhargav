# Store Analytics Dashboard

A full-stack take-home implementation for Amboras using NestJS (backend), Next.js (frontend), and PostgreSQL, aligned with the Store Analytics PRD and featuring a professional, high-density dashboard UI.

## Setup Instructions

### 1) Clone and install

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2) Start PostgreSQL

Run the provided docker-compose configuration to start PostgreSQL (and Redis).

```bash
# from repo root
docker compose up -d
```
*(Alternatively, you can use a local Postgres instance by creating a database named `amboras` and setting `DATABASE_URL`)*

### 3) Configure environment variables

Copy the root `.env.example` values into the respective sub-projects:
- `backend/.env`
- `frontend/.env.local`

### 4) Initialize schema and seed data

```bash
cd backend
npm run db:init
npm run db:seed
```
By default, the seed inserts 120,000 synthetic events across 3 stores. 

### 5) Run apps

Terminal 1 (Backend):
```bash
cd backend
npm run start:dev
```

Terminal 2 (Frontend):
```bash
cd frontend
npm run dev
```

Open http://localhost:3000, go to `/login`, and select a store. You will then land on the live Store Analytics Dashboard.

---

## Architecture Decisions

### Data Aggregation Strategy
- **Decision:** I used read-time SQL aggregations running directly against the raw PostgreSQL event tables. On the backend, I execute the 6 required metric queries in parallel using `Promise.all()`.
- **Why:** I chose this over building a dedicated ETL pipeline or using triggers to update separate aggregation tables because it's the fastest path to a working product. It keeps the architecture incredibly simple: there's only one source of truth, meaning I completely avoided all the headaches of cache invalidation or out-of-sync aggregation tables.
- **Trade-offs:** I sacrificed high-scale read performance for this simplicity. At the current scale (a few hundred thousand rows), it's totally fine, but calculating `COUNT` and `SUM` on the fly over millions of rows every 5 seconds is going to melt down the database CPU eventually.

### Real-time vs. Batch Processing
- **Decision:** I went with Real-time aggregations triggered directly by the client's HTTP polling.
- **Why:** The requirements asked for a dashboard that feels "live." If I had used batch processing (like a cron job rolling up events into a static table every 5-10 minutes), the dashboard would look stale and defeat the purpose of an operational telemetrics console. I want the user to see the metrics tick up the moment an action happens.
- **Trade-offs:** Speed vs. Database Load. By making it perfectly accurate up-to-the-second, I traded away database efficiency. Every active dashboard is a linear multiplier on database load. A batch-processed system could serve 10,000 concurrent viewers directly from a static cache, whereas my real-time approach will struggle under heavy traffic spikes.

### Frontend Data Fetching
- **Decision:** Standard HTTP short-polling via Next.js React `useEffect` and `setInterval` every 5 seconds, pulling down a full JSON snapshot of the dashboard state.
- **Why:** I chose HTTP polling over WebSockets or Server-Sent Events (SSE) because it just works out of the box. WebSockets are notoriously annoying to scale—they require sticky sessions on load balancers, custom reconnect logic, and connection management. HTTP is stateless. Furthermore, polling a single JSON snapshot means the frontend doesn't have to smartly "patch" its state; it completely overwrites whatever it's rendering with the absolute truth from the server, avoiding desyncs completely.
- **Trade-offs:** Polling is chatty and network-heavy. I'm forcing the browser to negotiate a new HTTP request every 5 seconds to fetch the exact same data payload even if no new visitors hit the store.

### Performance Optimizations
To make this brute-force approach fast enough to be UX-friendly, I relied on:
- **Indexes:** I threw composite B-Tree indexes on `(store_id, timestamp DESC)` and `(store_id, event_type, timestamp DESC)`. Since every query filters by store and time, these indexes drastically cut down the total rows the DB has to scan.
- **Parallelization:** Inside NestJS, I didn't await the DB queries sequentially. By using `Promise.all()`, the total endpoint response time is only as slow as the single slowest SQL query.
- **UI Rendering:** A major issue with 5-second polling is that charting libraries like Recharts animate their lines every time new data drops in—creating a horrible "jittering/twitching" effect. I explicitly disabled entrance animations (`isAnimationActive={false}`) and built a seamless state-switcher so that polling updates happen instantly without the DOM shifting or blinking.

## Known Limitations
- If a user selects a massive date range (like "Last Year") on a store with 50M+ events, the raw `COUNT(*)` grouping queries will almost certainly time out or thrash the DB's memory.
- Because there is no Redis cache aggressively buffering the 5-second poll endpoint, if 1,000 users leave their dashboard open in a background tab, the primary DB is going to get slammed with 6,000 heavy aggregation queries per second. It will run out of connection limits and break.

## What I'd Improve With More Time
If I had another week to bulletproof this system for mass scale:
1. **Materialized Views:** I'd fix the raw query bottleneck by migrating heavy aggregations out of the main events table and into PostgreSQL Materialized Views (refreshed asynchronously via a background worker) or using a time-series DB like **TimescaleDB** using continuous aggregates.
2. **Redis Cache Stampede Protection:** I'd wrap the backend dashboard controller in a 2-to-3 second Redis lock. This way, if 500 users poll concurrently in the exact same second, the DB only executes the SQL once—the other 499 users get the cached JSON instantly.
3. **WebSockets (Socket.io):** I'd rip out the 5-second HTTP short-polling entirely. Instead, the backend would keep an active socket open and push fractional, incremental diffs (e.g., `{ type: "page_view", count: +1 }`) solely when new events hit the Kafka stream / Event system.

## Time Spent
Approximately 4 hours covering the backend DB schema logic, integrating the frontend pipeline, redesigning the UI into a strict AWS-style grid, and debugging the layout and animation glitches.
