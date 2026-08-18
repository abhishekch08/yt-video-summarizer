import OpenAI from 'openai';
import { env } from '@/lib/env';

let openai: OpenAI | null = null;

export function ai() {
  if (!openai) openai = new OpenAI({ apiKey: env.openaiApiKey });
  return openai;
}
