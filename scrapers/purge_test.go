// purge_test.go — the admin purge route can only be honest if every scraper's
// Site exposes its cache. These tests pin that contract: a single site drops its
// own entries and reports the count, and PurgeAll reaches every registered site
// (the package-level origins and the external children they memoize).
package scrapers

import "testing"

func newPurgeTestSite(t *testing.T, base string) *Site {
	t.Helper()
	s := NewSite(SiteConfig{Base: base})
	s.cacheSet(base+"/a", "A")
	s.cacheSet(base+"/b", "B")
	if _, ok := s.cacheGet(base + "/a"); !ok {
		t.Fatal("cacheSet did not take effect — Purge cannot be tested")
	}
	return s
}

func TestPurgeDropsThisSitesCache(t *testing.T) {
	s := newPurgeTestSite(t, "https://purge-one.example")

	if n := s.Purge(); n != 2 {
		t.Fatalf("Purge() = %d, want 2", n)
	}
	if _, ok := s.cacheGet("https://purge-one.example/a"); ok {
		t.Error("Purge left an entry behind")
	}
	if len(s.order) != 0 {
		t.Errorf("Purge left %d keys in the eviction order", len(s.order))
	}
	if n := s.Purge(); n != 0 {
		t.Errorf("second Purge() = %d, want 0 (nothing left to evict)", n)
	}
}

func TestPurgeAllCoversEveryRegisteredSite(t *testing.T) {
	PurgeAll() // start from empty caches so the count is meaningful

	a := newPurgeTestSite(t, "https://purge-all-a.example")
	b := newPurgeTestSite(t, "https://purge-all-b.example")

	if n := PurgeAll(); n < 4 {
		t.Fatalf("PurgeAll() = %d, want >= 4 (two sites, two entries each)", n)
	}
	for _, s := range []*Site{a, b} {
		if _, ok := s.cacheGet(s.base + "/a"); ok {
			t.Errorf("%s still holds a cached response after PurgeAll", s.base)
		}
	}
	if n := PurgeAll(); n != 0 {
		t.Errorf("second PurgeAll() = %d, want 0", n)
	}
}

// Every real origin is registered at package init, so a purge with live traffic
// has something to clear. This also guards the registry itself: if NewSite stops
// registering, PurgeAll silently becomes a no-op again.
func TestPackageSitesAreRegistered(t *testing.T) {
	siteRegistryMu.Lock()
	n := len(siteRegistry)
	siteRegistryMu.Unlock()
	if n < 2 {
		t.Fatalf("only %d site(s) registered — NewSite no longer registers, so PurgeAll is a no-op", n)
	}
}
