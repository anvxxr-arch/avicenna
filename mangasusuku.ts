#!/usr/bin/env bun
/*
- base : https://mangasusuku.com
- creator : avicenna
- Themesia mangareader skin (reference implementation for scrapers/mangareader.go)
*/
import { createMangaReaderCli } from './core/mangareader';

if (import.meta.main) {
  createMangaReaderCli({
    name: 'mangasusuku',
    title: 'Mangasusuku Scraper (mangasusuku.com)',
    base: 'https://mangasusuku.com',
    seriesPath: '/komik/',
    azPath: '/az-list/',
    examples: `  bun mangasusuku.ts search "solo leveling"
  bun mangasusuku.ts detail solo-leveling
  bun mangasusuku.ts chapter solo-leveling-chapter-155
  bun mangasusuku.ts azlist A`,
  });
}
