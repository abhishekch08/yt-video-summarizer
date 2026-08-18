import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

// The app uses Supabase only from trusted server routes with a service-role/secret key.
// Keep the client untyped here so schema generation is not required for deployment.
// We can replace this with generated Database types later without changing runtime behavior.
let client: any = null;

export function db(): any {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
