import { Dashboard } from '../components/dashboard';

/** Avoid serving a stale static shell so browser/CDN always reconciles fresh client JS. */
export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <Dashboard />;
}
