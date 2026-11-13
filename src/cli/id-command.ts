import { readSupportId } from "../analytics/index.js";
import { resolveStateDir } from "../config/index.js";

/**
 * ATO-1466 — `atag id`: print the support id (the anonymous install id)
 * on its own line, so a user can paste it into a bug report or a chat
 * with support and we can find them in PostHog and Sentry. Read-only:
 * it never creates an id, and it works with analytics turned off.
 */
const HELP = [
  "Usage: atomic-agent id",
  "",
  "Print this install's support ID (the anonymous install id), for bug reports.",
  "It is read from ~/.atomic-agent-install-id, else <stateDir>/analytics.json.",
  "Nothing is sent anywhere; with analytics off you can still share it by hand.",
].join("\n");

export interface IdCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Defaults to `readSupportId` over the resolved state dir. */
  readId?: () => string | null;
}

export async function idCommand(
  args: string[],
  deps: IdCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr =
    deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  if (args.includes("-h") || args.includes("--help")) {
    write(`${HELP}\n`);
    return 0;
  }
  if (args.length > 0) {
    writeErr(`unknown option ${args[0]}\n\n${HELP}\n`);
    return 2;
  }
  const id = (
    deps.readId ?? (() => readSupportId({ stateDir: resolveStateDir() }))
  )();
  if (!id) {
    writeErr(
      "no install id yet: it is created the first time atomic-agent runs with analytics on\n",
    );
    return 1;
  }
  write(`${id}\n`);
  return 0;
}
