import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { fetchCaptionsAndMetadata } from '@/lib/youtube';
import { hasUsableTranscript, saveTranscript, upsertVideo } from '@/lib/video-store';

export const runtime = 'nodejs';
export const maxDuration = 300;

const AUDIO_CHUNK_SECONDS = 8 * 60;

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
    const message = error instanceof Error ? error.message : 'Could not prepare video';
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
