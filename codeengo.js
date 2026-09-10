/**
 * codeengo-text-to-image
 *
 * Scrape AI image generator from codeengo.com without API key.
 * Generated images are automatically uploaded to uguu.se for URL.
 *
 * Usage:
 *   node codeengo.js --styles        list all style presets
 *   node codeengo.js --test          generate all styles + upload
 *   node codeengo.js cyberpunk       generate a specific preset style
 *   node codeengo.js "custom text"   generate from freeform prompt
 *
 * Author: Nimzz
 * Source: codeengo.com
 */

import fs from 'fs/promises';

const BASE = 'https://codeengo.com';
const UGUU = 'https://uguu.se/upload';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; M2006C3MG)',
  'Origin': BASE,
  'Referer': `${BASE}/text-to-image.php`,
  'Content-Type': 'application/json'
};

const STYLES = {
  cyberpunk: 'A hyper-realistic cyber-enhanced hacker in a rain-soaked Tokyo alley, glowing magenta and cyan neon signs reflecting on wet asphalt, dense fog, holographic displays in windows, cinematic depth of field, SDXL-Lightning render, 8k resolution.',
  fantasy: 'Floating islands with waterfalls in a sunset sky, ghibli style',
  interior: 'Minimalist luxury living room with large glass windows overlooking forest',
  anime: 'cute anime girl with blue eyes',
  dragon: 'a majestic dragon over a snowy mountain, cinematic lighting, ultra-realistic',
  butterfly: 'Macro photography of a mechanical butterfly on a flower'
};

async function generate(prompt) {
  const res = await fetch(`${BASE}/api/image.php`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt })
  });

  const data = await res.json();

  if (!data.success || !data.image) {
    return { success: false, error: data.error || 'unknown error' };
  }

  const base64 = data.image.replace('data:image/png;base64,', '');
  const buffer = Buffer.from(base64, 'base64');
  const filename = `codeengo_${Date.now()}.jpg`;

  await fs.writeFile(filename, buffer);

  const form = new FormData();
  form.append('files[]', new Blob([buffer]), filename);

  const upload = await fetch(UGUU, { method: 'POST', body: form });
  const uploaded = await upload.json();
  const url = uploaded?.files?.[0]?.url || null;

  return {
    success: true,
    localPath: filename,
    url,
    sizeKB: Math.round(buffer.length / 1024)
  };
}

const arg = process.argv[2];

if (!arg) {
  console.log(JSON.stringify({ error: 'usage: node codeengo.js <style|prompt|--styles|--test>' }));
  process.exit(0);
}

if (arg === '--styles') {
  console.log(JSON.stringify(Object.keys(STYLES)));
  process.exit(0);
}

if (arg === '--test') {
  const results = [];

  for (const [name, prompt] of Object.entries(STYLES)) {
    const result = await generate(prompt);
    results.push({ style: name, ...result });
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(JSON.stringify(results));
  process.exit(0);
}

if (STYLES[arg]) {
  const result = await generate(STYLES[arg]);
  console.log(JSON.stringify({ style: arg, ...result }));
  process.exit(0);
}

const result = await generate(arg);
console.log(JSON.stringify(result));