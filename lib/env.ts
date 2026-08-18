function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  get geminiApiKey() { return required('GEMINI_API_KEY'); },
  get supadataApiKey() { return required('SUPADATA_API_KEY'); },
  get appPin() { return required('APP_PIN'); },
  get sessionSecret() { return required('SESSION_SECRET'); },
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get supabaseServiceRoleKey() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
  get youtubeCookie() { return process.env.YOUTUBE_COOKIE?.trim() || undefined; },
  get summaryModel() { return process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash'; },
  get classifierModel() { return process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.5-flash-lite'; },
};
