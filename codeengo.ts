#!/usr/bin/env bun
/*
- base : https://codeengo.com
- creator : Nimzz
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
*/

import { writeFile } from 'node:fs/promises';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };
declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string; length: number } };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const site = createSite({
  base: 'https://codeengo.com',
  rateMs: 500,
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; M2006C3MG)',
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'origin': 'https://codeengo.com',
    'referer': 'https://codeengo.com/text-to-image.php',
  },
});
const { postAjax } = site;

const UGUU = 'https://uguu.se/upload';

const STYLES: Record<string, string> = {
  cyberpunk: 'A hyper-realistic cyber-enhanced hacker in a rain-soaked Tokyo alley, glowing magenta and cyan neon signs reflecting on wet asphalt, dense fog, holographic displays in windows, cinematic depth of field, SDXL-Lightning render, 8k resolution.',
  fantasy: 'Floating islands with waterfalls in a sunset sky, ghibli style',
  interior: 'Minimalist luxury living room with large glass windows overlooking forest',
  anime: 'cute anime girl with blue eyes',
  dragon: 'a majestic dragon over a snowy mountain, cinematic lighting, ultra-realistic',
  butterfly: 'Macro photography of a mechanical butterfly on a flower',
};

/** Raw JSON POST — codeengo expects JSON content-type, so bypass postAjax form-encoding. */
async function generateRaw(prompt: string): Promise<Response> {
  const body = JSON.stringify({ prompt });
  if (body.length > 8192) throw new Error('Prompt too large');
  const res = await fetch('https://codeengo.com/api/image.php', {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; M2006C3MG)',
      'content-type': 'application/json',
      'origin': 'https://codeengo.com',
      'referer': 'https://codeengo.com/text-to-image.php',
    },
    signal: AbortSignal.timeout(60_000),
    body,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for image API`);
  return res;
}

async function generate(prompt: string): Promise<Record<string, unknown>> {
  const res = await generateRaw(prompt);
  const data = (await res.json()) as { success?: boolean; image?: string; error?: string };
  if (!data.success || !data.image) {
    return { success: false, error: data.error || 'unknown error' };
  }
  const base64 = data.image.replace('data:image/png;base64,', '');
  const buffer = Buffer.from(base64, 'base64');
  const filename = `codeengo_${Date.now()}.jpg`;
  await writeFile(filename, buffer);

  const form = new FormData();
  form.append('files[]', new Blob([buffer]), filename);
  const upload = await fetch(UGUU, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  const uploaded = (await upload.json()) as { files?: Array<{ url?: string }> };
  const url = uploaded?.files?.[0]?.url || null;

  return { success: true, localPath: filename, url, sizeKB: Math.round(buffer.length / 1024) };
}

// void postAjax — image API is JSON+binary, postAjax (text) not applicable; site kept on createSite for config consistency
void site;

if (import.meta.main) {
  defineCli({
    name: 'codeengo',
    title: 'Codeengo Text-to-Image',
    commands: {
      generate: {
        desc: 'Generate an image from a style preset or freeform prompt',
        usage: '<style|prompt>',
        run: async (pos) => {
          const arg = pos[0];
          if (!arg) throw new Error('Usage: codeengo generate <style|prompt>');
          if (STYLES[arg]) return { style: arg, ...(await generate(STYLES[arg])) };
          return generate(arg);
        },
      },
      styles: {
        desc: 'List all style presets',
        run: () => Object.keys(STYLES),
      },
      test: {
        desc: 'Generate all styles + upload (slow)',
        run: async () => {
          const results = [];
          for (const [name, prompt] of Object.entries(STYLES)) {
            results.push({ style: name, ...(await generate(prompt)) });
            await new Promise((r) => setTimeout(r, 1500));
          }
          return results;
        },
      },
    },
    examples: `  bun codeengo.ts generate cyberpunk
  bun codeengo.ts generate "custom text"
  bun codeengo.ts styles`,
  });
}
