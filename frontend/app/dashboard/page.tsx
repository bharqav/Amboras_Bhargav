import { permanentRedirect } from 'next/navigation';

/** Alias: dashboard lives at `/`; many users expect `/dashboard`. */
export default function DashboardAliasPage() {
  permanentRedirect('/');
}
