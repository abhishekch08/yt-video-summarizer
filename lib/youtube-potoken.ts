import { BotGuardClient } from 'bgutils-js/botguard';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import { env } from '@/lib/env';

type MinterCache = {
  minter: WebPoMinter;
  expiresAt: number;
};

let minterPromise: Promise<MinterCache> | null = null;

function youtubeHeaders() {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': USER_AGENT,
  };
  if (env.youtubeCookie) headers.cookie = env.youtubeCookie;
  return headers;
}

async function createMinter(): Promise<MinterCache> {
  // This follows BgUtils' current Node/YouTube.js WebPO flow. YouTube now protects
  // many media URLs with a content-bound Proof-of-Origin token; cookies alone are
  // frequently insufficient on cloud/serverless IP ranges.
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  });

  const pageResponse = await fetch('https://www.youtube.com/', {
    headers: youtubeHeaders(),
    cache: 'no-store',
  });
  if (!pageResponse.ok) throw new Error(`PoToken bootstrap page returned HTTP ${pageResponse.status}`);
  const pageHtml = await pageResponse.text();

  const ytConfigText = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!ytConfigText) throw new Error('PoToken bootstrap could not find YouTube configuration');

  const windowAny = dom.window as any;
  windowAny.yt = { config_: JSON.parse(ytConfigText) };

  Object.assign(globalThis as any, {
    yt: windowAny.yt,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });

  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  }

  const attestationMatch = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attestationMatch) throw new Error('PoToken bootstrap challenge was not present in YouTube page');

  const initialAttestationData: any = parseLooseJSON(attestationMatch[1]);
  const challengeResponse: any = initialAttestationData?.R;
  const bgChallenge: any = challengeResponse?.bgChallenge;
  if (!bgChallenge) throw new Error('PoToken BotGuard challenge was unavailable');

  const interpreterUrl = bgChallenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterUrl) throw new Error('PoToken BotGuard interpreter URL was unavailable');

  const bgScriptResponse = await fetch(`https:${interpreterUrl}`, {
    headers: youtubeHeaders(),
    cache: 'no-store',
  });
  if (!bgScriptResponse.ok) throw new Error(`PoToken interpreter returned HTTP ${bgScriptResponse.status}`);
  const interpreterJavascript = await bgScriptResponse.text();
  if (!interpreterJavascript) throw new Error('PoToken interpreter script was empty');

  // BotGuard intentionally supplies this VM script at runtime.
  new Function(interpreterJavascript)();

  const botGuardClient = await BotGuardClient.create({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    globalObject: globalThis,
  });

  const requestKey = 'O43z0dpjhgX20SCx4KAo';
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

  const integrityResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([requestKey, botguardResponse]),
    cache: 'no-store',
  });
  if (!integrityResponse.ok) throw new Error(`PoToken integrity service returned HTTP ${integrityResponse.status}`);

  const integrityJson = await integrityResponse.json() as [string, number, number, string];
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = integrityJson;
  if (!integrityToken) throw new Error('PoToken integrity token was empty');

  const minter = await WebPoMinter.create({
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  }, webPoSignalOutput);

  // Do not hold a minter indefinitely in a warm serverless process. Five minutes is
  // deliberately conservative even when YouTube reports a longer integrity-token TTL.
  const ttlSeconds = Number.isFinite(estimatedTtlSecs) && estimatedTtlSecs > 30
    ? Math.min(estimatedTtlSecs - 10, 300)
    : 180;

  return { minter, expiresAt: Date.now() + ttlSeconds * 1000 };
}

async function getMinter(forceRefresh = false) {
  if (forceRefresh) minterPromise = null;
  if (!minterPromise) {
    minterPromise = createMinter().catch((error) => {
      minterPromise = null;
      throw error;
    });
  }
  const cached = await minterPromise;
  if (cached.expiresAt <= Date.now()) {
    minterPromise = null;
    return getMinter(false);
  }
  return cached.minter;
}

export async function mintYoutubeContentPoToken(videoId: string) {
  try {
    const minter = await getMinter();
    return await minter.mintAsWebsafeString(videoId);
  } catch (firstError) {
    // One clean re-bootstrap handles a stale warm-instance challenge/minter without
    // making every request pay the BotGuard setup cost.
    try {
      const minter = await getMinter(true);
      return await minter.mintAsWebsafeString(videoId);
    } catch (secondError) {
      const first = firstError instanceof Error ? firstError.message : String(firstError);
      const second = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`PoToken generation failed. First attempt: ${first}. Retry: ${second}`);
    }
  }
}
