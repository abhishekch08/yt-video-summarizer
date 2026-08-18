import { generateText, generateTextStream } from '@/lib/gemini';
import { env } from '@/lib/env';
import { chunkText } from '@/lib/text';
import type { SummaryDepth, VideoType } from '@/types/app';

const TYPES: VideoType[] = ['technical', 'finance', 'tutorial', 'interview', 'news', 'education', 'general'];

export async function classifyVideo(title: string, transcript: string): Promise<VideoType> {
  try {
    const label = await generateText({
      model: env.classifierModel,
      instructions: `Classify a YouTube transcript into exactly one label: ${TYPES.join(', ')}. Output only the label.`,
      input: `TITLE: ${title}\n\nTRANSCRIPT SAMPLE:\n${transcript.slice(0, 12_000)}`,
      maxOutputTokens: 20,
    });
    const normalized = label.trim().toLowerCase() as VideoType;
    return TYPES.includes(normalized) ? normalized : 'general';
  } catch {
    return 'general';
  }
}

function depthRules(depth: SummaryDepth) {
  if (depth === 'concise') return 'Keep this very concise: roughly 6-10 high-information bullets plus at most one small table if it materially improves comprehension.';
  if (depth === 'detailed') return 'Produce detailed but edited notes. Capture all important arguments, steps, numbers, caveats, examples and conclusions without transcript-like repetition.';
  return 'Be concise but complete: start with a TL;DR of 5-10 bullets, then use a few content-adaptive sections. Use tables where comparisons, specifications, sequences or numbers benefit from them.';
}

function adaptiveRules(type: VideoType) {
  const map: Record<VideoType, string> = {
    technical: 'Prioritize concepts, architecture, mechanisms, specifications/numbers, tradeoffs, experiments/results and engineering implications.',
    finance: 'Prioritize thesis, business/financial drivers, numbers, catalysts, risks, valuation or market arguments, and conclusions stated by the speaker.',
    tutorial: 'Prioritize prerequisites, ordered steps, settings/commands, decision points, common mistakes, and final outcome.',
    interview: 'Prioritize the main ideas, speaker viewpoints, arguments, disagreements, examples and novel insights.',
    news: 'Prioritize what happened, chronology, stated causes, stated consequences, key actors and uncertainties mentioned in the video.',
    education: 'Prioritize core concepts, definitions, reasoning, equations or examples, and the learning takeaways.',
    general: 'Choose the clearest structure for the content and emphasize the most useful facts, arguments and takeaways.',
  };
  return map[type];
}

function baseInstructions(depth: SummaryDepth, type: VideoType) {
  return `You are summarizing a YouTube video from its transcript.

STRICT SOURCE RULES:
- Use ONLY information present in the supplied transcript/notes. Do not browse, fact-check, correct, or add outside facts.
- Write the summary in English even if the transcript is in another language.
- Do not include timestamps.
- Do not mention the transcript extraction process.
- Preserve important names, quantitative values, qualifications, caveats and uncertainty.
- Remove repetition, filler and conversational noise.
- Use Markdown.
- Do not mechanically use the same template for every video.

DEPTH: ${depth.toUpperCase()}
${depthRules(depth)}

CONTENT TYPE: ${type}
${adaptiveRules(type)}`;
}

async function condenseChunk(chunk: string, index: number, total: number, type: VideoType) {
  return generateText({
    model: env.summaryModel,
    instructions: `Create dense, loss-minimizing notes from transcript chunk ${index}/${total}. Use only the chunk. Preserve facts, numbers, arguments, caveats, steps and examples that could matter in a final summary. Content type: ${type}. Do not add external knowledge.`,
    input: chunk,
    maxOutputTokens: 3500,
  });
}

export async function prepareSummaryInput(transcript: string, type: VideoType, onProgress?: (message: string) => void) {
  const chunks = chunkText(transcript, 180_000);
  if (chunks.length === 1) return transcript;
  const notes: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Compressing long transcript ${i + 1}/${chunks.length}`);
    notes.push(await condenseChunk(chunks[i], i + 1, chunks.length, type));
  }
  return notes.map((note, i) => `## Source chunk ${i + 1}\n${note}`).join('\n\n');
}

export async function createSummaryStream(input: string, depth: SummaryDepth, type: VideoType) {
  return generateTextStream({
    model: env.summaryModel,
    instructions: baseInstructions(depth, type),
    input,
    maxOutputTokens: depth === 'detailed' ? 9000 : depth === 'concise' ? 2200 : 5000,
  });
}

export async function createAnswerStream(transcript: string, question: string) {
  return generateTextStream({
    model: env.summaryModel,
    instructions: `Answer the user's question using ONLY the supplied YouTube transcript. If the answer is not in the transcript, say that clearly. Do not use outside information. Answer in English. Be precise and concise.`,
    input: `QUESTION:\n${question}\n\nTRANSCRIPT:\n${transcript}`,
    maxOutputTokens: 3500,
  });
}
