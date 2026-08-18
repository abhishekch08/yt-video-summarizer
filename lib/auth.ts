import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

const COOKIE = 'yt_summary_session';
const SESSION_DAYS = 30;

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string) {
  return crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

export function safePinMatch(input: string) {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(env.appPin).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSessionToken() {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ exp, v: 1 });
  const encoded = b64url(payload);
  return `${encoded}.${sign(encoded)}`;
}

export function validateSessionToken(token?: string) {
  if (!token) return false;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return false;
  const expected = sign(encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp: number };
    return Number.isFinite(payload.exp) && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export async function isAuthenticated() {
  const jar = await cookies();
  return validateSessionToken(jar.get(COOKIE)?.value);
}

export async function requireAuth() {
  if (!(await isAuthenticated())) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

export async function setSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}
