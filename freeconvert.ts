#!/usr/bin/env bun
/*
- base : https://api.freeconvert.com/v1
- creator : phrzy
- migrated to core/ guards (spec 003) — ESM, uniform CLI
- needs an INPUT video file: bun freeconvert.ts compress <file> [target%]
*/

import fs from 'fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

const site = createSite({
  base: 'https://api.freeconvert.com/v1',
  rateMs: 600,
  headers: { 'accept': 'application/json' },
});
const { fetchPage, postAjax, isValidUrl } = site;

const API = 'https://api.freeconvert.com/v1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: 'get' | 'post', url: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  // all /process/jobs responses are JSON; auth goes as Bearer header
  const auth = token ? { authorization: `Bearer ${token}` } : undefined;
  const raw = method === 'get'
    ? await fetchPage(url) // GET with auth unsupported by fetchPage — jobs GET happens via waitDone below
    : await postAjax(url, JSON.stringify(body), API + '/process/jobs', auth);
  if (!isValidUrl(API + url)) throw new Error('bad api url');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function guestToken(): Promise<string> {
  // endpoint returns the raw JWT as text/plain — not JSON
  const raw = await fetchPage('/account/guest');
  const token = raw.trim().replace(/^"|"$/g, '');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('guest token missing/invalid');
  return token;
}

function jobBody(target: number) {
  return {
    tasks: {
      'import-1': { operation: 'import/upload' },
      'compress-1': {
        operation: 'compress',
        input: 'import-1',
        input_format: 'mp4',
        output_format: 'mp4',
        options: {
          video_codec_compress: 'libx264',
          compress_video: 'by_percentage',
          video_compress_quality_percentage: target,
        },
      },
      'export-1': { operation: 'export/url', input: 'compress-1', filename: 'wOrvCj_compressed.mp4' },
    },
  };
}

interface Job { id?: string; status?: string; tasks?: Array<{ operation: string; result?: { form?: { url: string; parameters: Record<string, string> } } | { url?: string } }> }

async function uploadFile(job: Job, token: string, file: string): Promise<unknown> {
  const task = job.tasks?.find((t) => t.operation === 'import/upload');
  const form = task?.result?.form;
  if (!form?.url || !isValidUrl(form.url)) throw new Error('no upload form URL');
  const fd = new FormData();
  fd.append('signature', form.parameters.signature);
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
  const res = await fetch(form.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
  return res.json();
}

async function waitDone(id: string, token: string): Promise<Job> {
  for (let i = 0; i < 120; i++) {
    // authenticated GET — fetchPage has no auth, use direct fetch with guards
    if (!isValidUrl(`${API}/process/jobs/${id}`)) throw new Error('job URL blocked');
    const res = await fetch(`${API}/process/jobs/${id}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`job poll HTTP ${res.status}`);
    const job = (await res.json()) as Job;
    if (job.status === 'completed') return job;
    if (job.status === 'failed' || job.status === 'error') throw new Error('job failed: ' + JSON.stringify(job));
    process.stdout.write(`status ${job.status}...\n`);
    await sleep(5000);
  }
  throw new Error('timeout waiting for job');
}

async function download(url: string, dir = 'downloads'): Promise<{ file: string; url: string; md5: string; bytes: number }> {
  if (!isValidUrl(url)) throw new Error('download URL blocked by guards');
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const md5 = createHash('md5').update(buf).digest('hex');
  const cd = res.headers.get('content-disposition') || '';
  const name = (cd.match(/filename="?([^";]+)/) || [null, null])[1] || 'compressed.mp4';
  const file = path.join(dir, `${Date.now()}_${md5}_${name}`);
  fs.writeFileSync(file, buf);
  return { file, url, md5, bytes: buf.length };
}

async function compress(input: string, target: number): Promise<Record<string, unknown>> {
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`);
  const token = await guestToken();
  const created = await api('post', '/process/jobs', jobBody(target), token) as Job;
  const id = created.id;
  if (!id) throw new Error('no job id: ' + JSON.stringify(created));
  const upload = await uploadFile(created, token, input);
  const job = await waitDone(id, token);
  const task = job.tasks?.find((t) => t.operation === 'export/url');
  const url = (task?.result as { url?: string })?.url || '';
  const saved = url ? await download(url) : null;
  return { id, status: job.status, upload, job, saved };
}

if (import.meta.main) {
  defineCli({
    name: 'freeconvert',
    title: 'FreeConvert Video Compressor',
    commands: {
      compress: {
        desc: 'Upload + compress a video to target size percentage',
        usage: '<file> [target%]',
        run: async (pos) => {
          const input = pos[0] || 'downloads/input.mp4';
          const target = Math.min(100, Math.max(1, parseInt(pos[1] || '60') || 60));
          return compress(input, target);
        },
      },
    },
    examples: `  bun freeconvert.ts compress downloads/input.mp4 40`,
  });
}
