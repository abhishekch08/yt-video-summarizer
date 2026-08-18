import { requireAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { classifyVideo, createSummaryStream, prepareSummaryInput } from '@/lib/summary';
import { getVideo, hasUsableTranscript, saveSummary } from '@/lib/video-store';
import type { SummaryDepth, VideoType } from '@/types/app';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DEPTHS = new Set<SummaryDepth>(['concise', 'standard', 'detailed']);
const enc = new TextEncoder();

function sse(payload: unknown) {
  return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  const { depth = 'standard' } = await req.json();
  if (!DEPTHS.has(depth)) return new Response(JSON.stringify({ error: 'Invalid summary depth' }), { status: 400, headers: { 'content-type': 'application/json' } });

  const video = await getVideo(id);
  if (!hasUsableTranscript(video)) {
    return new Response(JSON.stringify({ error: 'Transcript needs to be re-fetched.', needsRefresh: true }), { status: 409, headers: { 'content-type': 'application/json' } });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sse({ type: 'stage', message: 'Preparing summary' }));
        let type = video.video_type as VideoType | null;
        if (!type) {
          controller.enqueue(sse({ type: 'stage', message: 'Adapting summary structure' }));
          type = await classifyVideo(video.title, video.transcript!);
          await db().from('videos').update({ video_type: type }).eq('id', id);
        }

        const summaryInput = await prepareSummaryInput(video.transcript!, type, (message) => {
          controller.enqueue(sse({ type: 'stage', message }));
        });
        controller.enqueue(sse({ type: 'stage', message: 'Writing summary' }));

        const summaryStream = await createSummaryStream(summaryInput, depth, type);
        let full = '';
        for await (const text of summaryStream) {
          full += text;
          controller.enqueue(sse({ type: 'delta', text }));
        }
        if (!full.trim()) throw new Error('Summary generation returned no text.');
        await saveSummary(id, depth, full);
        controller.enqueue(sse({ type: 'done', depth, videoType: type }));
      } catch (error) {
        controller.enqueue(sse({ type: 'error', message: error instanceof Error ? error.message : 'Summary failed' }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
