import AppShell from '@/components/AppShell';
import { isAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let authenticated = false;
  try { authenticated = await isAuthenticated(); } catch {}
  return <AppShell initialAuthenticated={authenticated} />;
}
