// Package scrapers hosts the Go ports of the Bun/TypeScript scrapers, sharing a
// single hardened transport (transport.go) so every site gets the same SSRF
// guards, per-host rate limiting, timeouts, size caps and retry policy.
package scrapers

import "sort"

// Command is one CLI subcommand of a Scraper. Run receives the positional
// arguments after the command name and the parsed --flags map (bare switches
// are "true"); it returns the payload that will be JSON-encoded.
type Command struct {
	Name  string
	Desc  string
	Usage string
	// Flags maps a flag name to "value" (may consume the next token) or "bool".
	Flags map[string]string
	Run   func(args []string, flags map[string]string) (any, error)
}

// Scraper is a named bundle of commands.
type Scraper struct {
	Name     string
	Title    string
	Commands map[string]Command
}

// registry holds every scraper in this package.
var registry []Scraper

// register appends a scraper to the package registry (called from each
// scraper's init).
func register(s Scraper) { registry = append(registry, s) }

// All returns every scraper ported into this package, ordered by name.
func All() []Scraper {
	out := make([]Scraper, len(registry))
	copy(out, registry)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Find looks a scraper up by its CLI name.
func Find(name string) (Scraper, bool) {
	for _, s := range All() {
		if s.Name == name {
			return s, true
		}
	}
	return Scraper{}, false
}
