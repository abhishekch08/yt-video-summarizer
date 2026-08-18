import { GoogleGenAI } from '@google/genai';
import { env } from '@/lib/env';

let client: GoogleGenAI | null = null;

function gemini() {
  if (!client) client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

export async function generateText(options: {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
}) {
  const response = await gemini().models.generateContent({
    model: options.model,
    contents: options.input,
    config: {
      systemInstruction: options.instructions,
      maxOutputTokens: options.maxOutputTokens,
    },
  });
  return response.text?.trim() || '';
}

export async function* generateTextStream(options: {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
}) {
  const stream = await gemini().models.generateContentStream({
    model: options.model,
    contents: options.input,
    config: {
      systemInstruction: options.instructions,
      maxOutputTokens: options.maxOutputTokens,
    },
  });

  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield text;
  }
}
