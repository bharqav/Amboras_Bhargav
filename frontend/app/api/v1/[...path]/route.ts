import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
/** Node runtime so `fetch` to `localhost` works reliably in dev (Edge cannot reach loopback). */
export const runtime = 'nodejs';

const DEFAULT_UPSTREAM = 'http://localhost:4000/api/v1';
const DEV_FALLBACK_UPSTREAMS = ['http://localhost:4200/api/v1', 'http://localhost:4000/api/v1'];

/** Nest base URL ending with `/api/v1` (from `next.config.mjs` / env). */
function upstreamBase(): string {
  let raw = (process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_UPSTREAM).trim().replace(/\/$/, '');
  if (!raw.includes('/api/v1')) {
    raw = `${raw}/api/v1`;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return DEFAULT_UPSTREAM.replace(/\/$/, '');
    }
    return raw;
  } catch {
    return DEFAULT_UPSTREAM.replace(/\/$/, '');
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'host') {
      return;
    }
    out.set(key, value);
  });
  return out;
}

async function proxy(req: NextRequest, segments: string[]) {
  const subpath = segments.length ? segments.join('/') : '';
  const primaryBase = upstreamBase();
  const candidateBases =
    process.env.NODE_ENV === 'development'
      ? [
          primaryBase,
          ...DEV_FALLBACK_UPSTREAMS.filter((u) => u.replace(/\/$/, '') !== primaryBase.replace(/\/$/, '')),
        ]
      : [primaryBase];
  const target = `${primaryBase}/${subpath}${req.nextUrl.search}`;
  const isDashboardPoll = subpath === 'analytics/dashboard';
  const startedAt = Date.now();

  if (process.env.NODE_ENV === 'development' && isDashboardPoll) {
    // Visible heartbeat in the frontend terminal so polling can be confirmed at a glance.
    console.log(`[proxy] dashboard -> ${target}`);
  }

  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders(req.headers),
    cache: 'no-store',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await req.arrayBuffer();
    if (body.byteLength) {
      init.body = body;
    }
  }

  let res: Response | null = null;
  let lastDetail = '';
  for (const base of candidateBases) {
    const attemptTarget = `${base}/${subpath}${req.nextUrl.search}`;
    try {
      res = await fetch(attemptTarget, init);
      break;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      continue;
    }
  }

  if (!res) {
    return NextResponse.json(
      {
        statusCode: 502,
        message: 'Cannot reach the analytics API. Start the backend (e.g. npm run start:dev in /backend) and check NEXT_PUBLIC_API_BASE_URL matches its PORT.',
        error: 'Bad Gateway',
        detail: process.env.NODE_ENV === 'development' ? (lastDetail || 'fetch failed') : undefined,
        upstream: process.env.NODE_ENV === 'development' ? target : undefined,
        attemptedUpstreams: process.env.NODE_ENV === 'development' ? candidateBases : undefined,
      },
      { status: 502 },
    );
  }

  if (process.env.NODE_ENV === 'development' && isDashboardPoll) {
    console.log(`[proxy] dashboard <- ${res.status} in ${Date.now() - startedAt}ms`);
  }

  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) {
      return;
    }
    outHeaders.set(key, value);
  });

  return new NextResponse(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
}

type RouteCtx = { params: { path?: string[] } };

export async function GET(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, ctx.params.path ?? []);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, ctx.params.path ?? []);
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, ctx.params.path ?? []);
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, ctx.params.path ?? []);
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, ctx.params.path ?? []);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
