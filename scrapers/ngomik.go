// ngomik.go — 02.ngomik.cc registration (Themesia mangareader skin, the
// newest variant: /manga/ series URLs, .tsinfo info rows, PageSpeed lazy
// images, no A-Z directory).
package scrapers

func init() {
	site := newMangaReaderSite(
		"ngomik",
		"Ngomik ID Scraper (02.ngomik.cc)",
		"https://02.ngomik.cc",
		"/manga/",
		"",
	)
	register(site.scraper())
}
