// kanzenin.go — kanzenin.info registration (Themesia mangareader skin).
// Series URLs live under /manga/<slug>/; chapters are root slugs
// (<series>-chapter-<n>/); the A-Z directory is /a-z-list/.
package scrapers

func init() {
	site := newMangaReaderSite(
		"kanzenin",
		"Kanzenin Scraper (kanzenin.info)",
		"https://kanzenin.info",
		"/manga/",
		"/a-z-list/",
	)
	register(site.scraper())
}
