/**
 * core/cli.ts — uniform CLI runner for all scrapers.
 * Command table → help text, [ERROR]→stderr exit 1, JSON output. Spec 003.
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): void;
};

export interface CommandDef {
  desc: string;
  /** run receives positional args (after the command) and parsed --flags. Return value is JSON-printed. */
  run(pos: string[], flags: Record<string, string>): Promise<unknown> | unknown;
  /** positional usage hint, e.g. "<query>" */
  usage?: string;
}

export interface CliDef {
  name: string;
  title: string;
  commands: Record<string, CommandDef>;
  /** examples block printed in help */
  examples?: string;
}

export function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags[arg.slice(2)] = '';
      else flags[arg.slice(2, eq)] = arg.slice(eq + 1).slice(0, 200);
    } else pos.push(arg);
  }
  return { cmd: pos[0] || '', pos: pos.slice(1), flags };
}

export function defineCli(def: CliDef): void {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));

  function printUsage(): void {
    const lines = Object.entries(def.commands)
      .map(([k, c]) => `  ${def.name} ${k} ${c.usage || ''}`.padEnd(58) + c.desc);
    console.log(`
${def.title}
${'='.repeat(Math.max(def.title.length, 20))}
Commands:
${lines.join('\n')}
${def.examples ? `\nExamples:\n${def.examples}` : ''}`);
  }

  if (!cmd || cmd === 'help' || cmd === '--help') { printUsage(); return; }

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
