import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { fetchCaptionsAndMetadata } from '@/lib/youtube';
import { hasUsableTranscript, saveTranscript, upsertVideo } from '@/lib/video-store';

export const runtime = 'nodejs';
export const maxDuration = 300;

const AUDIO_CHUNK_SECONDS = 8 * 60;

function readableError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const parts = [value.message, value.details, value.hint, value.code]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    if (parts.length) return parts.join(' | ');
    try { return JSON.stringify(error); } catch {}
  }
  if (typeof error === 'string' && error.trim()) return error;
  return 'Could not prepare video';
}

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const { url, forceRefresh = false } = await req.json();
    if (typeof url !== 'string') return NextResponse.json({ error: 'URL is required' }, { status: 400 });

    const result = await fetchCaptionsAndMetadata(url);
    const video = await upsertVideo({
      sourceVideoId: result.metadata.videoId,
      url: result.metadata.url,
      title: result.metadata.title,
      channelName: result.metadata.channel,
      durationSeconds: result.metadata.durationSeconds,
    });

    if (!forceRefresh && hasUsableTranscript(video)) {
      return NextResponse.json({
        status: 'ready',
        videoId: video.id,
        title: video.title,
        durationSeconds: video.duration_seconds,
        transcriptSource: video.transcript_source,
      });
    }

    if (result.transcript) {
      await saveTranscript(video.id, result.transcript, 'captions');
      return NextResponse.json({
        status: 'ready',
        videoId: video.id,
        title: video.title,
        durationSeconds: video.duration_seconds,
        transcriptSource: 'captions',
      });
    }

    const duration = result.metadata.durationSeconds;
    if (!duration) throw new Error('No captions were available and video duration could not be determined for audio transcription.');
    const totalChunks = Math.ceil(duration / AUDIO_CHUNK_SECONDS);
    return NextResponse.json({
      status: 'needs_transcription',
      videoId: video.id,
      title: video.title,
      durationSeconds: duration,
      chunkSeconds: AUDIO_CHUNK_SECONDS,
      totalChunks,
    });
  } catch (error) {
    console.error('Video prepare failed:', error);
    return NextResponse.json({ error: readableError(error) }, { status: 422 });
  }
}
