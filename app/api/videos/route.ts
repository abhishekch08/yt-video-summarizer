import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q')?.trim() || '';
    const type = url.searchParams.get('type')?.trim() || 'all';
    const date = url.searchParams.get('date')?.trim() || 'all';

    let query = db()
      .from('videos')
      .select('id,source,source_video_id,url,title,channel_name,duration_seconds,video_type,transcript_source,transcript_expires_at,summary_concise,summary_standard,summary_detailed,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(200);

    if (q) query = query.ilike('title', `%${q.replace(/[%_]/g, '')}%`);
    if (type !== 'all') query = query.eq('video_type', type);
    if (date !== 'all') {
      const days = Number(date.replace('d', ''));
      if (Number.isFinite(days) && days > 0) {
        query = query.gte('created_at', new Date(Date.now() - days * 86400000).toISOString());
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ videos: data || [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load history' }, { status: 500 });
  }
}
