import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read KEY=value from dotenv-style file contents (first match wins). */
function parseEnvFileValue(text, key) {
  const prefix = `${key}=`;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(prefix)) {
      continue;
    }
    let val = line.slice(prefix.length).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val || null;
  }
  return null;
}

/**
 * Prefer values from project .env files over process.env.
 * A stale NEXT_PUBLIC_API_BASE_URL in the shell (e.g. IDE terminal) would otherwise win and ignore .env.local.
 */
function apiBaseFromFrontendEnvFiles() {
  for (const name of ['.env.local', '.env']) {
    const envPath = join(__dirname, name);
    if (!existsSync(envPath)) {
      continue;
    }
    try {
      const text = readFileSync(envPath, 'utf8');
      const v = parseEnvFileValue(text, 'NEXT_PUBLIC_API_BASE_URL');
      if (v) {
        return v;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Read PORT= from sibling backend/.env so the UI matches the API without duplicating the port in .env.local */
function apiBaseFromBackendEnv() {
  const envPath = join(__dirname, '..', 'backend', '.env');
  if (!existsSync(envPath)) {
    return null;
  }
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('PORT=') || line.startsWith('#')) {
        continue;
      }
      let port = line.slice('PORT='.length).trim();
      if ((port.startsWith('"') && port.endsWith('"')) || (port.startsWith("'") && port.endsWith("'"))) {
        port = port.slice(1, -1);
      }
      if (/^\d+$/.test(port)) {
        return `http://localhost:${port}/api/v1`;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

const nextPublicApi =
  apiBaseFromFrontendEnvFiles() ||
  apiBaseFromBackendEnv() ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://localhost:4000/api/v1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE_URL: nextPublicApi,
  },
  /**
   * API: `app/api/v1/[...path]/route.ts` proxies to Nest (`NEXT_PUBLIC_API_BASE_URL`). No rewrites — avoids
   * duplicate routing and keeps one obvious place for the backend URL.
   */
};

export default nextConfig;
