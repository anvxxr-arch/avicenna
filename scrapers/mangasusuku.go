// mangasusuku.go — mangasusuku.com registration (Themesia mangareader skin).
// Series URLs live under /komik/<slug>/; chapters are root slugs
// (<series>-chapter-<n>/); the A-Z directory is /az-list/.
package scrapers

func init() {
	site := newMangaReaderSite(
		"mangasusuku",
		"Mangasusuku Scraper (mangasusuku.com)",
		"https://mangasusuku.com",
		"/komik/",
		"/az-list/",
	)
	register(site.scraper())
}
