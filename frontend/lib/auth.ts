export type OwnerSession = {
  email: string;
  name: string;
  storeId: string;
};

const OWNER_KEY = 'amboras_owner_profile';
const ACCESS_TOKEN_KEY = 'amboras_access_token_client';

export function hasAuthSession(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return Boolean(window.localStorage.getItem(OWNER_KEY));
}

export function setAuthSession(owner: OwnerSession) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(OWNER_KEY, JSON.stringify(owner));
}

export function getOwnerSession(): OwnerSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(OWNER_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as OwnerSession;
  } catch {
    return null;
  }
}

export function clearAuthSession() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(OWNER_KEY);
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  try {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Client JWT for `Authorization` on cross-origin API calls (and SSE query params).
 * Stored in localStorage so new tabs / hard reloads still authenticate when cookies are not sent.
 */
export function setSessionAccessToken(token: string) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
  try {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getSessionAccessToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const fromLocal = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  if (fromLocal) {
    return fromLocal;
  }
  const legacy = window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
  if (legacy) {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, legacy);
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    return legacy;
  }
  return null;
}
