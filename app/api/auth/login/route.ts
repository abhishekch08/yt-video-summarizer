import { NextResponse } from 'next/server';
import { safePinMatch, setSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { pin } = await req.json();
    if (typeof pin !== 'string' || !pin) {
      return NextResponse.json({ error: 'PIN is required' }, { status: 400 });
    }
    if (!safePinMatch(pin)) {
      await new Promise((r) => setTimeout(r, 300));
      return NextResponse.json({ error: 'Incorrect PIN' }, { status: 401 });
    }
    await setSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Login failed' }, { status: 500 });
  }
}
