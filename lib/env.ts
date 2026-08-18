function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  get openaiApiKey() { return required('OPENAI_API_KEY'); },
  get appPin() { return required('APP_PIN'); },
  get sessionSecret() { return required('SESSION_SECRET'); },
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get supabaseServiceRoleKey() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
  get youtubeCookie() { return process.env.YOUTUBE_COOKIE?.trim() || undefined; },
  get summaryModel() { return process.env.OPENAI_SUMMARY_MODEL || 'gpt-5-mini'; },
  get classifierModel() { return process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-5-nano'; },
  get transcribeModel() { return process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'; },
};
