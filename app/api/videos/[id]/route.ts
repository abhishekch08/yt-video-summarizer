import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { getVideo, hasUsableTranscript } from '@/lib/video-store';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  try {
    const video = await getVideo(id);
    const { transcript: _hidden, ...safe } = video;
    return NextResponse.json({ video: { ...safe, transcript_available: hasUsableTranscript(video) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Video not found' }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  try {
    const { error } = await db().from('videos').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Delete failed' }, { status: 500 });
  }
}
