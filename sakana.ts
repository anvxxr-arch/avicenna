#!/usr/bin/env bun
/*
- base : https://chat.sakana.ai
- creator : rynaqrtz
- migrated to core/ guards (spec 003) — ESM, uniform CLI
- NOTE: FIREBASE_KEY in legacy is a redacted placeholder ('AIzaSy...f_I4') — the signup
  flow requires the REAL web API key. Set SAKANA_FIREBASE_KEY env to make chat/models work.
*/

import { randomUUID } from 'node:crypto';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const BASE = 'https://chat.sakana.ai';
const FIREBASE_KEY = process.env.SAKANA_FIREBASE_KEY || 'AIzaSy...f_I4';
const MODELS = ['namazu', 'sakana', 'namazu-v2', 'namazu-pro', 'llama'];

const site = createSite({ base: BASE, rateMs: 500 });
const { fetchPage } = site;

interface SignupResp { idToken?: string; error?: { message?: string } }

async function signupIdToken(): Promise<string> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true, tenantId: 'sakana-talk-prd-pvl72' }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as SignupResp;
  if (!data.idToken) {
    throw new Error(`Firebase signup failed: ${data.error?.message || res.status} (is SAKANA_FIREBASE_KEY valid?)`);
  }
  return data.idToken;
}

async function loginCookie(idToken: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'origin': BASE,
      'referer': BASE,
    },
    body: new URLSearchParams({ idToken }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const cookies = res.headers.getSetCookie?.() || [];
  const cookie = cookies.find((c) => c.startsWith('sakana-chat='))?.split(';')[0];
  if (!cookie) throw new Error('Failed to get session cookie');
  return cookie;
}

async function getCookie(): Promise<string> {
  const idToken = await signupIdToken();
  return loginCookie(idToken);
}

async function getModels(): Promise<string[]> {
  const cookie = await getCookie();
  const res = await fetch(`${BASE}/api/agents`, {
    headers: { cookie },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`agents HTTP ${res.status}`);
  const data = (await res.json()) as Array<{ id: string }>;
  return data.map((a) => a.id);
}

function cleanText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^-\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ChatResult { text: string; conversationId: string; parentMessageId: string | null }

async function chat(question: string, opts: {
  model?: string; conversationId?: string | null; needSearch?: number; thinking?: number; toneMode?: string; streamOutput?: boolean;
} = {}): Promise<ChatResult> {
  const {
    model = 'namazu',
    conversationId = null,
    parentMessageId = null,
    needSearch = 0,
    thinking = 0,
    toneMode = 'default',
    streamOutput = false,
  } = opts;

  if (!question) throw new Error('Question is required.');
  if (thinking && needSearch) throw new Error('Thinking and Web Search cannot be used together.');
  if (!MODELS.includes(model)) throw new Error(`Model not found. Available: ${MODELS.join(', ')}`);

  const cookie = await getCookie();
  let convId = conversationId;
  let parentId = parentMessageId;

  if (!convId) {
    const res = await fetch(`${BASE}/conversation`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: BASE, referer: BASE },
      body: JSON.stringify({
        inputs: question,
        enableThinking: thinking === 1,
        toneMode,
        webSearchEnabled: needSearch === 1,
        agentId: model,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`conversation create HTTP ${res.status}`);
    const data = (await res.json()) as { conversationId: string; systemMessageId: string };
    convId = data.conversationId;
    parentId = data.systemMessageId;
  }

  const payload = JSON.stringify({
    inputs: question,
    id: parentId,
    is_retry: false,
    is_continue: false,
    enableThinking: thinking === 1,
    toneMode,
    webSearchEnabled: needSearch === 1,
    userMessageId: randomUUID(),
  });

  const res = await fetch(`${BASE}/conversation/${convId}`, {
    method: 'POST',
    headers: {
      cookie,
      'origin': BASE,
      'referer': BASE,
      'x-requested-with': 'com.xbrowser.play',
      // Bun FormData handles the multipart boundary automatically
    },
    body: (() => {
      const fd = new FormData();
      fd.append('data', payload);
      return fd;
    })(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) throw new Error(`chat stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let messageId: string | null = null;
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; messageId?: string; token?: string };
        if (parsed.type === 'createdMessage' && parsed.messageId) messageId = parsed.messageId;
        if (parsed.type === 'stream' && parsed.token) {
          fullText += parsed.token.replace(/\0/g, '');
          if (streamOutput) {
            // stream inline like legacy (thinking tags dimmed)
            process.stdout.write(parsed.token.replace(/\0/g, ''));
          }
        }
      } catch { /* skip non-JSON lines */ }
    }
  }

  const cleaned = cleanText(
    fullText
      .replace(/<plan>[\s\S]*?<\/plan>/g, '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<source-chip[^>]*\/>/g, '')
      .replace(/<\/?[a-zA-Z0-9_-]+[^>]*>/g, ''),
  );
  if (streamOutput) process.stdout.write('\n');
  return { text: cleaned, conversationId: convId!, parentMessageId: messageId };
}

if (import.meta.main) {
  defineCli({
    name: 'sakana',
    title: 'SakanaAI Chat (chat.sakana.ai)',
    commands: {
      chat: {
        desc: 'Tanya SakanaAI', usage: '<question> [--model namazu] [--search] [--thinking] [--stream]',
        run: async (pos, flags) => {
          const question = pos.join(' ');
          const result = await chat(question, {
            model: flags.model || 'namazu',
            needSearch: flags.search ? 1 : 0,
            thinking: flags.thinking ? 1 : 0,
            streamOutput: !!flags.stream,
          });
          return {
            creator: 'rynaqrtz',
            info: { model: flags.model || 'namazu', search: !!flags.search, thinking: !!flags.thinking, status: 'ok' },
            data: { text: result.text, conversationId: result.conversationId, parentMessageId: result.parentMessageId },
          };
        },
      },
      models: {
        desc: 'List available agent models',
        run: async () => ({ creator: 'rynaqrtz', info: { command: 'models', status: 'ok' }, data: { models: await getModels() } }),
      },
    },
    examples: `  bun sakana.ts chat "halo siapa kamu"
  SAKANA_FIREBASE_KEY=<key> bun sakana.ts chat "hi"`,
  });
}

export { chat, getModels };
