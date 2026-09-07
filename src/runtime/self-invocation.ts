/**
 * How this very program is re-run as a child: the command and the
 * leading arguments that land in the same CLI dispatcher, so that
 * `[...prefix, "models", "pull-worker", …]` reaches `modelsCommand`
 * whether the parent is the SEA binary or `node dist/cli/index.js`.
 *
 * Pure: `process` values arrive as inputs, so every branch is
 * unit-reachable. The same reasoning lives in `tui-command.ts`'s
 * self-update relaunch and `build-terminal-launch.ts`'s `agentArgv`.
 */
import { createRequire } from "node:module";

/**
 * `node:sea` cannot be imported statically: Vite's module graph does not
 * resolve it and every test importing this module would fail to load.
 * Same lazy `createRequire` as `native/load-better-sqlite3.ts`; outside
 * a SEA build the require fails and the answer is simply "no".
 */
const bootRequire = createRequire(import.meta.url);

export function isSeaBuild(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

export interface SelfInvocationInput {
  /** `process.execPath`. */
  readonly execPath: string;
  /** `process.argv`. */
  readonly argv: readonly string[];
  /** `process.execArgv` — loader/inspect flags a dev run needs back. */
  readonly execArgv?: readonly string[];
  /** `isSea()` — a SEA binary is its own entry point, no script path. */
  readonly isSea: boolean;
}

export interface SelfInvocation {
  readonly cmd: string;
  /** Everything before the user command. */
  readonly args: readonly string[];
}

export function selfInvocation(input: SelfInvocationInput): SelfInvocation {
  const execArgv = input.execArgv ?? [];
  if (input.isSea) {
    return { cmd: input.execPath, args: [...execArgv] };
  }
  const scriptPath = input.argv[1];
  if (!scriptPath) {
    throw new Error("cannot re-run this program: no script path in argv");
  }
  return { cmd: input.execPath, args: [...execArgv, scriptPath] };
}
