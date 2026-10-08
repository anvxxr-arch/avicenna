// ssrf_test.go — the URL/host pinning boundary, pinned offline.
//
// Everything a scraper fetches comes from a URL a caller supplied: a site path,
// a detail URL, a redirect Location, or a media/CDN URL. The guards that decide
// whether any byte leaves the process live in transport.go and jsonapi.go, and
// none of them had a single test — a silently weakened guard (a missing
// obfuscation, a dropped check) would still pass parity, because parity only
// exercises the URLs the sites happen to return. These tables hold the boundary
// in place: no host that is loopback/private/link-local/metadata, no
// credentials, no non-http(s) scheme, and nothing outside an explicit allowlist.
//
// The Site values here are literals on purpose: NewSite registers into the
// process-wide purge registry, so building one would leak a fake origin into
// PurgeAll's count.
package scrapers

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

// newPinnedSite is a host-pinned Site without registry side effects.
func newPinnedSite(host string, extra ...string) *Site {
	base := "https://" + host
	return &Site{base: base, host: strings.ToLower(host), extraHosts: extra}
}

func TestIsBlockedHostCoversEveryObfuscation(t *testing.T) {
	blocked := []string{
		// names
		"localhost", "LOCALHOST", "LocalHost",
		// dotted loopback / unspecified / private / link-local
		"127.0.0.1", "127.0.0.2", "127.1", "127.0.1", "0.0.0.0", "0",
		"10.0.0.1", "10.255.255.255", "192.168.0.1", "192.168.100.6",
		"172.16.0.1", "172.31.255.255",
		"169.254.169.254", // cloud metadata
		// numeric obfuscations a WHATWG URL parser normalises but url.Parse keeps
		"2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "0177.0.0.1",
		// IPv6 literal, bracketed or bare
		"::1", "[::1]", "::",
		"::ffff:127.0.0.1", "::ffff:169.254.169.254",
		"fc00::1", "fd12:3456:789a::1", "fe80::1",
	}
	for _, h := range blocked {
		if !IsBlockedHost(h) {
			t.Errorf("IsBlockedHost(%q) = false, want true", h)
		}
	}

	allowed := []string{
		"example.com", "s13.nontonanimeid.boats", "www.tiktok.com",
		"open.spotify.com", "api-partner.spotify.com",
		"8.8.8.8", "1.1.1.1",
		"172.15.0.1", "172.32.0.1", // just outside 172.16/12
		"192.169.0.1", "11.0.0.1",
		"2001:4860:4860::8888",
	}
	for _, h := range allowed {
		if IsBlockedHost(h) {
			t.Errorf("IsBlockedHost(%q) = true, want false — a public host must stay reachable", h)
		}
	}

	// The empty host is not this function's job: ParseTarget rejects it first as
	// ErrInvalidURL. Pinned here so nobody "fixes" the split by returning true.
	if IsBlockedHost("") {
		t.Error(`IsBlockedHost("") = true; an empty host is ParseTarget's rejection, not this guard's`)
	}
}

func TestParseTargetRejectsHostileTargets(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error // nil = accepted
	}{
		{"ok https", "https://example.com/path?q=1", nil},
		{"ok http", "http://example.com/", nil},
		{"ok trimmed", "  https://example.com/x  ", nil},
		{"ok port", "https://example.com:8443/x", nil},

		{"empty", "", ErrInvalidURL},
		{"blank", "   ", ErrInvalidURL},
		{"not a url", "not-a-url", ErrInvalidURL},
		{"no scheme", "example.com/x", ErrInvalidURL},
		{"javascript scheme (no host)", "javascript:alert(1)", ErrInvalidURL},
		{"file scheme (no host)", "file:///etc/passwd", ErrInvalidURL},
		{"ftp scheme", "ftp://example.com/x", ErrBlockedScheme},

		{"creds", "https://user:pw@example.com/", ErrCredsInURL},
		{"user only", "https://user@example.com/", ErrCredsInURL},
		{"userinfo spoof of a pinned host", "https://s13.nontonanimeid.boats@evil.com/x", ErrCredsInURL},

		{"loopback", "http://127.0.0.1:8899/api/v1", ErrBlockedHost},
		{"loopback numeric", "http://2130706433/", ErrBlockedHost},
		{"loopback ipv6", "http://[::1]:8080/", ErrBlockedHost},
		{"metadata", "http://169.254.169.254/latest/meta-data/", ErrBlockedHost},
		{"private", "http://192.168.100.6:22/", ErrBlockedHost},
		{"localhost name", "http://localhost/admin", ErrBlockedHost},
	}
	for _, c := range cases {
		u, err := ParseTarget(c.raw)
		if c.want == nil {
			if err != nil {
				t.Errorf("%s: ParseTarget(%q) = %v, want accepted", c.name, c.raw, err)
			}
			if u == nil {
				t.Errorf("%s: ParseTarget(%q) returned nil URL without an error", c.name, c.raw)
			}
			continue
		}
		if !errors.Is(err, c.want) {
			t.Errorf("%s: ParseTarget(%q) = %v, want %v", c.name, c.raw, err, c.want)
		}
	}

	// A rejected host must name the host, or the 502 is undiagnosable in logs.
	_, err := ParseTarget("http://169.254.169.254/latest/meta-data/")
	if err == nil || !strings.Contains(err.Error(), "169.254.169.254") {
		t.Errorf("blocked-host error = %v, want it to name the host", err)
	}
}

func TestResolveURLReappliesGuardsOnEveryHop(t *testing.T) {
	base := "https://s13.nontonanimeid.boats/anime/x/"
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr string
	}{
		{name: "relative path", raw: "/anime/y/", want: "https://s13.nontonanimeid.boats/anime/y/"},
		{name: "doc-relative", raw: "episode-1/", want: "https://s13.nontonanimeid.boats/anime/x/episode-1/"},
		{name: "absolute same host", raw: "https://s13.nontonanimeid.boats/z", want: "https://s13.nontonanimeid.boats/z"},
		// ResolveURL only re-applies the *blocked* checks; the per-origin
		// allowlist is allowedRedirectHost's job (see the next test). Pinned so a
		// reader does not mistake this for a missing guard.
		{name: "off-site host passes here", raw: "https://evil.com/z", want: "https://evil.com/z"},
		{name: "protocol-relative passes here", raw: "//evil.com/z", want: "https://evil.com/z"},
		// resolveUrl mirrors the reference: it clears only the credentials, so a
		// fragment survives here (sanitizeUrl clears it). A fragment never reaches
		// the wire, so keeping it is harmless — and the ports must agree.
		{name: "fragment kept", raw: "https://s13.nontonanimeid.boats/z#frag", want: "https://s13.nontonanimeid.boats/z#frag"},

		{name: "javascript", raw: "javascript:alert(1)", wantErr: "Bad redirect scheme"},
		{name: "data", raw: "data:text/html,<script>", wantErr: "Bad redirect scheme"},
		{name: "creds", raw: "http://user:pw@evil.com/", wantErr: "Creds in URL blocked"},
		{name: "loopback", raw: "http://127.0.0.1/x", wantErr: "Blocked redirect host"},
		{name: "ipv4-mapped loopback", raw: "http://[::ffff:127.0.0.1]/x", wantErr: "Blocked redirect host"},
		{name: "metadata", raw: "http://169.254.169.254/x", wantErr: "Blocked redirect host"},
		{name: "too long", raw: "https://example.com/" + strings.Repeat("a", maxURLBytes+64), wantErr: "URL too long"},
	}
	for _, c := range cases {
		got, err := ResolveURL(c.raw, base)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: ResolveURL(%q) err = %v, want %q", c.name, c.raw, err, c.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: ResolveURL(%q) = %v, want %q", c.name, c.raw, err, c.want)
			continue
		}
		if got != c.want {
			t.Errorf("%s: ResolveURL(%q) = %q, want %q", c.name, c.raw, got, c.want)
		}
	}
}

func TestSiteURLPinningIsExactHostMatch(t *testing.T) {
	s := newPinnedSite("example.com", "cdn.example.com")

	ok := []string{
		"https://example.com/x",
		"https://example.com/x?q=1",
		"http://example.com/x",
		"https://EXAMPLE.com/x", // case-insensitive
		"https://example.com:8443/x",
	}
	for _, raw := range ok {
		if _, err := s.assertSiteURL(raw); err != nil {
			t.Errorf("assertSiteURL(%q) = %v, want accepted", raw, err)
		}
	}

	refused := []string{
		"https://evil.com/x",
		"https://example.com.evil.com/x", // suffix trick
		"https://sub.example.com/x",      // subdomains are NOT implied
		"https://cdn.example.com/x",      // ExtraHosts covers redirect hops, not targets
		"https://127.0.0.1/x",
		"https://localhost/x",
		"http://2130706433/x",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"",
	}
	for _, raw := range refused {
		if _, err := s.assertSiteURL(raw); err == nil {
			t.Errorf("assertSiteURL(%q) = nil error, want refused", raw)
		}
	}
}

func TestSanitizeURLKeepsTraversalOnThePinnedHost(t *testing.T) {
	s := newPinnedSite("example.com", "cdn.example.com")

	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr string
	}{
		{name: "absolute path", raw: "/anime/y", want: "https://example.com/anime/y"},
		{name: "relative", raw: "anime/y", want: "https://example.com/anime/y"},
		{name: "query kept", raw: "/s?q=x", want: "https://example.com/s?q=x"},
		// Traversal cannot leave the host: the path is normalised, the host stays.
		{name: "traversal normalised", raw: "/../../etc/passwd", want: "https://example.com/etc/passwd"},
		// Truncation, not rejection, is the documented design for long paths.
		{name: "long path truncated", raw: "/" + strings.Repeat("a", maxURLBytes+200)},

		{name: "empty", raw: "", wantErr: "Empty URL"},
		{name: "nul byte", raw: "/a\x00b", wantErr: "Illegal chars in URL"},
		{name: "backslash", raw: "/a\\b", wantErr: "Illegal chars in URL"},
		{name: "javascript", raw: "javascript:alert(1)", wantErr: "Blocked URL scheme"},
		{name: "data", raw: "data:text/html,x", wantErr: "Blocked URL scheme"},
		{name: "vbscript", raw: "vbscript:msgbox(1)", wantErr: "Blocked URL scheme"},
		{name: "external host", raw: "https://evil.com/x", wantErr: "External host rejected"},
		{name: "protocol-relative host", raw: "//evil.com/x", wantErr: "External host rejected"},
		{name: "sibling subdomain", raw: "https://cdn.example.com/x", wantErr: "External host rejected"},
	}
	for _, c := range cases {
		got, err := s.sanitizeURL(c.raw)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: sanitizeURL(%q) err = %v, want %q", c.name, c.raw, err, c.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: sanitizeURL(%q) = %v, want accepted", c.name, c.raw, err)
			continue
		}
		if c.want != "" && got != c.want {
			t.Errorf("%s: sanitizeURL(%q) = %q, want %q", c.name, c.raw, got, c.want)
		}
		if c.name == "long path truncated" {
			if !strings.HasPrefix(got, "https://example.com/") {
				t.Errorf("truncated URL lost the pinned host: %q", got)
			}
			if len(got) > len(s.base)+maxURLBytes+1 {
				t.Errorf("truncated URL is %d bytes, want <= %d", len(got), len(s.base)+maxURLBytes+1)
			}
		}
	}
}

// TestAllowedRedirectHostIsAnExactAllowlist pins the deliberate difference from
// the TS reference: core/fetch.ts widens the pin with `corsSite && sameSiteHost`
// (sibling subdomains of the registrable domain), which Go does not implement.
// Go replaces that implicit widening with an explicit per-call allowlist
// (tiktokHosts, spotifyHosts, fcHosts, …), which is strictly narrower. A
// redirect to a sibling subdomain that TS would follow is refused here, and that
// is the intended behaviour — do not "fix" it by adding same-site matching.
func TestAllowedRedirectHostIsAnExactAllowlist(t *testing.T) {
	s := newPinnedSite("example.com", "cdn.example.com")

	allowed := []string{"example.com", "EXAMPLE.COM", "cdn.example.com", "CDN.Example.com"}
	for _, h := range allowed {
		if !s.allowedRedirectHost(h, nil) {
			t.Errorf("allowedRedirectHost(%q) = false, want true", h)
		}
	}
	// A per-call extra list (the `hosts` argument at every call site) is honoured too.
	if !s.allowedRedirectHost("api.other.com", []string{"API.Other.com"}) {
		t.Error("a host from the per-call allowlist must be accepted")
	}

	refused := []string{"", "evil.com", "localhost", "127.0.0.1", "example.com.evil.com", "sub.example.com", "notexample.com"}
	for _, h := range refused {
		if s.allowedRedirectHost(h, nil) {
			t.Errorf("allowedRedirectHost(%q) = true, want false", h)
		}
	}
}

func TestAPICheckHostGuardsBeforeAnyFetch(t *testing.T) {
	allow := map[string]bool{"example.com": true}

	if err := apiCheckHost(nil, allow); err == nil {
		t.Error("a nil URL must be refused")
	}
	// Every row goes through url.Parse (the caller's job), so apiCheckHost's own
	// ranked guards are what is under test here.
	cases := []struct {
		raw     string
		wantErr string
	}{
		{"https://example.com/", ""},
		{"https://example.com:8443/x?q=1", ""},
		{"https://evil.com/", "External host rejected"},
		{"https://sub.example.com/", "External host rejected"},
		{"javascript:alert(1)", "Invalid URL"},
		{"file:///etc/passwd", "Invalid URL"},
		{"", "Invalid URL"},
		{"https://user:pw@example.com/", "Creds in URL blocked"},
		{"http://127.0.0.1/", "Blocked host"},
		{"http://169.254.169.254/", "Blocked host"},
		{"http://2130706433/", "Blocked host"},
		{"http://[::1]/", "Blocked host"},
	}
	for _, c := range cases {
		u, perr := url.Parse(c.raw)
		if perr != nil {
			t.Errorf("url.Parse(%q) failed in the test setup: %v", c.raw, perr)
			continue
		}
		err := apiCheckHost(u, allow)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("apiCheckHost(%q) = %v, want nil", c.raw, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("apiCheckHost(%q) = %v, want %q", c.raw, err, c.wantErr)
		}
	}
}

// TestExternalAllowlistRejectsBeforeDialling proves the third-party path refuses
// an unlisted or private host without opening a connection (the check runs
// before externalSite/Do, so this stays offline).
func TestExternalAllowlistRejectsBeforeDialling(t *testing.T) {
	s := newPinnedSite("example.com")

	if _, err := s.External("https://evil.com/x", nil, "", []string{"cdn.example.com"}); err == nil ||
		!strings.Contains(err.Error(), "External host rejected") {
		t.Errorf("External(evil.com) = %v, want External host rejected", err)
	}
	if _, err := s.External("http://169.254.169.254/latest/meta-data/", nil, "", []string{"169.254.169.254"}); err == nil {
		t.Error("External(metadata) must be refused even when the caller allowlists it")
	}
	if _, err := s.External("http://127.0.0.1/x", nil, "", []string{"127.0.0.1"}); err == nil {
		t.Error("External(loopback) must be refused even when the caller allowlists it")
	}

	// siteRequestOpts shares the same guard and must reject before its limiter.
	if _, err := siteRequest(s, "https://evil.com/x", "GET", nil, nil, true, []string{"example.com"}); err == nil ||
		!strings.Contains(err.Error(), "External host rejected") {
		t.Errorf("siteRequest(evil.com) = %v, want External host rejected", err)
	}
}

// TestExplicitAllowlistsHoldOnlyPublicHosts guards the security boundary itself:
// a typo in an allowlist (" localhost", a trailing space, an IP, a scheme) either
// widens the pin or silently breaks every redirect hop on that path.
func TestExplicitAllowlistsHoldOnlyPublicHosts(t *testing.T) {
	lists := map[string][]string{
		"fcHosts":             fcHosts,
		"ytvHosts":            ytvHosts,
		"sakanaChatHosts":     sakanaChatHosts,
		"sakanaFirebaseHosts": sakanaFirebaseHosts,
		"tiktokHosts":         tiktokHosts,
		"tiktokCDNHosts":      tiktokCDNHosts,
		"ytmHosts":            ytmHosts,
		"spotifyHosts":        spotifyHosts,
	}
	for name, hosts := range lists {
		if len(hosts) == 0 {
			t.Errorf("%s is empty — the guard would reject every request", name)
			continue
		}
		for _, h := range hosts {
			switch {
			case h == "":
				t.Errorf("%s holds an empty entry", name)
			case h != strings.TrimSpace(h):
				t.Errorf("%s holds %q with stray whitespace", name, h)
			case h != strings.ToLower(h):
				t.Errorf("%s holds %q — allowlist entries are compared lower-case", name, h)
			case strings.ContainsAny(h, "/:@"):
				t.Errorf("%s holds %q — a hostname, not a URL", name, h)
			case !strings.Contains(h, "."):
				t.Errorf("%s holds %q — not a registrable hostname", name, h)
			case IsBlockedHost(h):
				t.Errorf("%s allowlists %q, which IsBlockedHost refuses — the pin and the guard disagree", name, h)
			}
		}
	}
}
