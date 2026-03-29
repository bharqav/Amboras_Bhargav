'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Store } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { loginOwner } from '../../lib/api';
import { hasAuthSession, setAuthSession, setSessionAccessToken } from '../../lib/auth';

const STORES = [
  { id: 1 as const, label: 'Store 1', email: 'owner1@amboras.dev', password: 'amboras-store-001' },
  { id: 2 as const, label: 'Store 2', email: 'owner2@amboras.dev', password: 'amboras-store-002' },
  { id: 3 as const, label: 'Store 3', email: 'owner3@amboras.dev', password: 'amboras-store-003' },
];

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<1 | 2 | 3 | null>(null);

  useEffect(() => {
    if (hasAuthSession()) {
      router.replace('/');
    }
  }, [router]);

  async function openStore(id: 1 | 2 | 3) {
    const store = STORES.find((s) => s.id === id);
    if (!store) return;

    setError(null);
    setLoadingId(id);

    try {
      const result = await loginOwner(store.email, store.password);
      if (!result?.owner?.storeId) {
        throw new Error('Login succeeded but profile was missing. Check the API response.');
      }
      setAuthSession(result.owner);
      if (result.accessToken) {
        setSessionAccessToken(result.accessToken);
      }
      // Full navigation so the httpOnly session cookie is reliably used on the next page (avoids SPA race with dashboard fetch).
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open store');
      setLoadingId(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 p-6 md:p-10">
      <Card className="border-border/80 shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl md:text-3xl">Store analytics</CardTitle>
          <CardDescription>Choose a store to view its live dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-2">
          {STORES.map((store) => (
            <Button
              key={store.id}
              type="button"
              className="h-14 w-full justify-center gap-2 text-base font-semibold"
              disabled={loadingId !== null}
              onClick={() => void openStore(store.id)}
            >
              <Store className="h-5 w-5" aria-hidden />
              {loadingId === store.id ? 'Opening…' : store.label}
            </Button>
          ))}
          {error && <p className="text-center text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
