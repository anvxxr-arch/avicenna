package scrapers

import (
	"strings"
	"testing"
)

// TestTiktokValidateVideoURLPinsTheFetchTarget proves the caller-supplied video
// URL is pinned to the two shapes the fetcher can handle BEFORE any request —
// the TS reference relies on the site's registrable-domain pin alone, which
// lets a lookalike host through to a generic rejection (or, on a short link,
// lets a crafted Location pick the destination).
func TestTiktokValidateVideoURLPinsTheFetchTarget(t *testing.T) {
	valid := []string{
		"https://www.tiktok.com/video/7301234567890123456",
		"https://www.tiktok.com/video/7301234567890123456?is_copy=1",
		"https://www.tiktok.com/video/7301234567890123456?is_copy=1&_t=890",
		"https://vm.tiktok.com/ZM8abcDEF/",
		"https://vt.tiktok.com/ZS1234567890",
		"  https://www.tiktok.com/video/7301234567890123456  ", // trimmed
	}
	for _, u := range valid {
		if err := tiktokValidateVideoURL(u); err != nil {
			t.Errorf("tiktokValidateVideoURL(%q) = %v, want nil", u, err)
		}
	}

	invalid := []string{
		"",
		"   ",
		"http://www.tiktok.com/video/7301234567890123456", // http, not https
		"https://m.tiktok.com/video/7301234567890123456",  // mobile host
		"https://tiktok.com/video/7301234567890123456",    // apex host
		"https://www.tiktok.com/video/123",                // too short an id
		"https://www.tiktok.com/video/abcdef",             // non-numeric id
		"https://www.tiktok.com/@user",                    // profile, not a video
		"https://www.tiktok.com/tag/x",
		"https://www.tiktok.com.evil.com/video/7301234567890123456", // lookalike: passes the registrable-domain pin
		"https://evil.com",
		"https://vm.tiktok.com.evil.com/ZM8abcDEF",
		"https://vt.tiktok.com",        // no token
		"https://vm.tiktok.com/",       // empty token
		"https://vm.tiktok.com/a b",    // space in token
		"https://vm.tiktok.com/../etc", // traversal is not a token
		"javascript:alert(1)",
		"file:///etc/passwd",
		"https://127.0.0.1/video/7301234567890123456",
		"https://169.254.169.254/latest/meta-data/",
		"https://user:pass@www.tiktok.com/video/7301234567890123456", // creds in URL
	}
	for _, u := range invalid {
		if err := tiktokValidateVideoURL(u); err == nil {
			t.Errorf("tiktokValidateVideoURL(%q) = nil, want an error", u)
		}
	}
}

// TestTiktokGetVideoRejectsOffShapeURLsBeforeAnyFetch proves the guard sits at
// the entry point: a URL that is not a canonical video page and not a short
// link is refused with the specific message, and no network call is attempted
// (the error must be the validator's, not a transport's).
func TestTiktokGetVideoRejectsOffShapeURLsBeforeAnyFetch(t *testing.T) {
	off := []string{
		"https://www.tiktok.com.evil.com/video/7301234567890123456",
		"https://evil.com/video/7301234567890123456",
		"https://www.tiktok.com/@someone",
		"http://www.tiktok.com/video/7301234567890123456",
	}
	for _, u := range off {
		info, err := tiktokGetVideo(u)
		if err == nil {
			t.Errorf("tiktokGetVideo(%q) = %+v, want the shape error", u, info)
			continue
		}
		if !strings.Contains(err.Error(), "URL tidak valid") {
			t.Errorf("tiktokGetVideo(%q) error = %q, want the shape error (not a transport error)", u, err)
		}
	}
}

// TestTiktokShortLinkResolutionStillWorks pins the short-link path: a valid
// short link must still be accepted by the validator (the resolver itself is
// exercised live by the parity suite).
func TestTiktokShortLinkResolutionStillWorks(t *testing.T) {
	for _, u := range []string{
		"https://vm.tiktok.com/ZM8abcDEF/",
		"https://vt.tiktok.com/ZS1234567890",
	} {
		if err := tiktokValidateVideoURL(u); err != nil {
			t.Errorf("tiktokValidateVideoURL(%q) = %v, want nil (short links stay accepted)", u, err)
		}
		if !tiktokShortLinkRe.MatchString(u) {
			t.Errorf("tiktokShortLinkRe no longer matches %q — the resolver gate changed", u)
		}
	}
}
