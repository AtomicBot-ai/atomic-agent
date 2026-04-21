/**
 * Fetch runtime assets required by the bundled sidecar. At the moment the
 * operator-flavoured atomic-agent has no external assets to pre-download:
 *
 *   - llama-server binaries  — the user runs their own server.
 *   - Chrome / Edge          — we attach to the system browser; no
 *                               Chromium download is performed.
 *   - Skills                 — runtime artefacts authored locally.
 *   - Tree-sitter grammars   — removed together with the coding pipeline.
 *
 * The script is kept as a no-op so `npm run bundle:fetch-assets` stays a
 * valid step in CI pipelines and future additions (e.g. a GBNF grammar
 * bundle or a tokenizer vocab file) can plug in here without touching
 * the package.json wiring.
 */
import { argv, exit, stdout } from "node:process";

function parseArgs(args: string[]): { force: boolean } {
  return { force: args.includes("--force") || args.includes("-f") };
}

async function main(): Promise<number> {
  const opts = parseArgs(argv.slice(2));
  stdout.write(
    `fetch-assets: no external assets required (force=${opts.force})\n`,
  );
  return 0;
}

main().then((code) => exit(code));
