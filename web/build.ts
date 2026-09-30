#!/usr/bin/env bun
/**
 * web/build.ts — Bun-native bundler for the React frontend (no Vite, no Node).
 *
 *   bun web/build.ts           # production bundle -> web/dist
 *   bun web/build.ts --dev     # unminified + sourcemaps
 *
 * Tailwind v4 is compiled by bun-plugin-tailwind straight from web/styles.css.
 */
import { rm, rename } from 'node:fs/promises';
import tailwind from 'bun-plugin-tailwind';

const dev = process.argv.includes('--dev');
const outdir = 'web/dist';

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ['web/index.html'],
  outdir,
  target: 'browser',
  minify: !dev,
  sourcemap: dev ? 'linked' : 'none',
  splitting: true,
  naming: dev ? '[name].[ext]' : '[name]-[hash].[ext]',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The HTML entry is emitted hashed; the SPA server and every deep link need it
// at /index.html with asset URLs absolute (so they resolve from any route).
const htmlOut = result.outputs.find((o) => o.path.endsWith('.html'));
if (htmlOut) {
  const absolute = (await htmlOut.text())
    .replace(/(href|src)="\.\//g, '$1="/')
    .replace(/(href|src)="([^":/][^"]*\.[a-z]+)"/g, '$1="/$2"');
  await Bun.write(`${outdir}/index.html`, absolute);
}

const sizes = await Promise.all(
  result.outputs.map(async (o) => `${o.path.replace(`${outdir}/`, '')} ${(o.size / 1024).toFixed(1)}kB`),
);
console.log(`build ${dev ? '(dev)' : '(min)'} -> ${outdir}`);
for (const s of sizes.sort()) console.log(`  ${s}`);
