import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { cleanTranscript } from '@/lib/text';
import { saveTranscript } from '@/lib/video-store';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  try {
    const { data, error } = await db().from('transcript_chunks').select('chunk_index,text').eq('video_id', id).order('chunk_index');
    if (error) throw error;
    if (!data?.length) throw new Error('No transcribed chunks were found.');
    const transcript = cleanTranscript(data.map((row) => row.text));
    if (!transcript) throw new Error('Combined transcription was empty.');
    await saveTranscript(id, transcript, 'audio');
    const { error: deleteError } = await db().from('transcript_chunks').delete().eq('video_id', id);
    if (deleteError) throw deleteError;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not finalize transcription' }, { status: 422 });
  }
}
