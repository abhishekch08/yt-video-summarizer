import { db } from '@/lib/supabase';
import type { SummaryDepth, VideoRecord } from '@/types/app';

export async function getVideo(id: string) {
  const { data, error } = await db().from('videos').select('*').eq('id', id).single();
  if (error) throw error;
  return data as VideoRecord & { transcript?: string | null };
}

export async function upsertVideo(input: {
  sourceVideoId: string;
  url: string;
  title: string;
  channelName: string | null;
  durationSeconds: number | null;
}) {
  const { data, error } = await db()
    .from('videos')
    .upsert({
      source: 'youtube',
      source_video_id: input.sourceVideoId,
      url: input.url,
      title: input.title,
      channel_name: input.channelName,
      duration_seconds: input.durationSeconds,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'source,source_video_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as VideoRecord & { transcript?: string | null };
}

export async function saveTranscript(videoId: string, transcript: string, source: 'captions' | 'audio') {
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db().from('videos').update({
    transcript,
    transcript_source: source,
    transcript_expires_at: expires,
    updated_at: new Date().toISOString(),
  }).eq('id', videoId);
  if (error) throw error;
}

export function hasUsableTranscript(video: VideoRecord & { transcript?: string | null }) {
  if (!video.transcript) return false;
  if (!video.transcript_expires_at) return true;
  return new Date(video.transcript_expires_at).getTime() > Date.now();
}

export async function saveSummary(videoId: string, depth: SummaryDepth, text: string) {
  const column = `summary_${depth}`;
  const { error } = await db().from('videos').update({
    [column]: text,
    updated_at: new Date().toISOString(),
  }).eq('id', videoId);
  if (error) throw error;
}
