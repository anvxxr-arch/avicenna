#!/usr/bin/env bun
/*
- base : https://02.ngomik.cc
- creator : avicenna
- Themesia mangareader skin (reference implementation for scrapers/mangareader.go)
*/
import { createMangaReaderCli } from './core/mangareader';

if (import.meta.main) {
  createMangaReaderCli({
    name: 'ngomik',
    title: 'Ngomik ID Scraper (02.ngomik.cc)',
    base: 'https://02.ngomik.cc',
    seriesPath: '/manga/',
    azPath: '',
    examples: `  bun ngomik.ts search "eleceed"
  bun ngomik.ts detail eleceed
  bun ngomik.ts chapter eleceed-chapter-420`,
  });
}
