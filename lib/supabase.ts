import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

let client: ReturnType<typeof createClient> | null = null;

export function db() {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
