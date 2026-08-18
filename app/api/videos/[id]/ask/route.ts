import { requireAuth } from '@/lib/auth';
import { createAnswerStream } from '@/lib/summary';
import { getVideo, hasUsableTranscript } from '@/lib/video-store';

export const runtime = 'nodejs';
export const maxDuration = 300;
const enc = new TextEncoder();
const sse = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  const { question } = await req.json();
  if (typeof question !== 'string' || !question.trim()) {
    return new Response(JSON.stringify({ error: 'Question is required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const video = await getVideo(id);
  if (!hasUsableTranscript(video)) {
    return new Response(JSON.stringify({ error: 'Transcript needs to be re-fetched.', needsRefresh: true }), { status: 409, headers: { 'content-type': 'application/json' } });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const answerStream = await createAnswerStream(video.transcript!, question.trim());
        for await (const text of answerStream) controller.enqueue(sse({ type: 'delta', text }));
        controller.enqueue(sse({ type: 'done' }));
      } catch (error) {
        controller.enqueue(sse({ type: 'error', message: error instanceof Error ? error.message : 'Q&A failed' }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } });
}
