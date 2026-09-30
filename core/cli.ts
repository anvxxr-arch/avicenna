/**
 * core/cli.ts — uniform CLI runner for all scrapers.
 * Command table → help text, [ERROR]→stderr exit 1, JSON output. Spec 003.
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): void;
};
/** `value` = may consume the next token; `bool`/absent = switch (`'true'`). */
export type FlagSpec = Record<string, 'value' | 'bool'>;
export interface CommandDef {
  desc: string;
  /** run receives positional args (after the command) and parsed --flags. Return value is JSON-printed. */
  run(pos: string[], flags: Record<string, string>): Promise<unknown> | unknown;
  /** positional usage hint, e.g. "<query>" */
  usage?: string;
  /**
   * Flags that take a value in space form (`--k v`). Everything else is a
   * switch. `--k=v` always sets a value. Without this list `--k v` is
   * ambiguous and can swallow a positional.
   */
  flags?: FlagSpec;
}
export interface CliDef {
  name: string;
  title: string;
  commands: Record<string, CommandDef>;
  /** examples block printed in help */
  examples?: string;
}
/**
 * Flag semantics:
 *   --k=v   → { k: 'v' }     (always)
 *   --k v   → { k: 'v' }     (only when `spec.k === 'value'`)
 *   --k     → { k: 'true' }  (bare switch — truthy, unlike the old '' that made
 *                            `--search`/`--thinking` silently dead)
 */
export function parseArgs(
  argv: string[],
  spec: FlagSpec = {},
): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { pos.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1).slice(0, 200); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (spec[key] === 'value' && next !== undefined && !next.startsWith('--')) {
      flags[key] = next.slice(0, 200);
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  return { cmd: pos[0] || '', pos: pos.slice(1), flags };
}
export function defineCli(def: CliDef): void {
  const first = parseArgs(process.argv.slice(2));
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2), def.commands[first.cmd]?.flags);
  function printUsage(): void {
    const lines = Object.entries(def.commands)
      .map(([k, c]) => `  ${def.name} ${k} ${c.usage || ''}`.padEnd(58) + c.desc);
    const banner = def.title.split('\n');
    const width = Math.max(...banner.map((l) => l.length), 20);
    console.log([
      `\n${banner[0]}`,
      '='.repeat(width),
      ...banner.slice(1),
      'Commands:',
      ...lines,
      def.examples ? `\nExamples:\n${def.examples}` : '',
    ].join('\n'));
  }
  if (!cmd || cmd === 'help' || flags.help !== undefined || flags.h !== undefined) { printUsage(); return; }
  const c = def.commands[cmd];
  if (!c) {
    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  }
  Promise.resolve()
    .then(() => c.run(pos, flags))
    .then((v) => { console.log(JSON.stringify(v, null, 2)); })
    .catch((e) => {
      console.error(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
