#!/usr/bin/env bun
/*
- base : https://kanzenin.info
- creator : avicenna
- Themesia mangareader skin (reference implementation for scrapers/mangareader.go)
*/
import { createMangaReaderCli } from './core/mangareader';

if (import.meta.main) {
  createMangaReaderCli({
    name: 'kanzenin',
    title: 'Kanzenin Scraper (kanzenin.info)',
    base: 'https://kanzenin.info',
    seriesPath: '/manga/',
    azPath: '/a-z-list/',
    examples: `  bun kanzenin.ts search "family control"
  bun kanzenin.ts detail family-control
  bun kanzenin.ts chapter family-control-chapter-5
  bun kanzenin.ts azlist A`,
  });
}
