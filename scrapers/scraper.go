// Package scrapers hosts the Go ports of the Bun/TypeScript scrapers, sharing a
// single hardened transport (transport.go) so every site gets the same SSRF
// guards, per-host rate limiting, timeouts, size caps and retry policy.
package scrapers

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
