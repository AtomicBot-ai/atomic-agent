/**
 * After-edit diagnostics from real language servers (ATO-503): after
 * `os.fs.write` / `os.fs.edit` / `os.fs.patch` change a TypeScript,
 * JavaScript or Python file, the tool result also lists the compiler
 * and type errors the change added — "Type 'string' is not assignable
 * to 'number'", "Cannot find name 'foo'" — the way an IDE would show
 * them, so a model fixes them in the next step instead of finding out
 * from a failed run much later.
 *
 * Rules, all of them on purpose:
 *  - off unless `tools.lsp.enabled` is set (memory and start-up time
 *    next to a local model);
 *  - only inside a git work tree, never at home or a filesystem root,
 *    so no daemon starts for a stray file in Downloads;
 *  - only servers already on PATH (`typescript-language-server`,
 *    `pyright-langserver`); nothing is ever installed;
 *  - started lazily, on the first edit of a matching file, one per
 *    language per repository, and reused;
 *  - a language server runs the project's own code (tsconfig plugins,
 *    a local TypeScript, pyright's environment), so in a folder the
 *    operator has not trusted the first start asks once for the work
 *    tree and the answer is kept for it; no answer (a surface without a
 *    window, a refuse policy) starts nothing;
 *  - only errors the change added (`lsp-delta.ts`);
 *  - advisory: bounded in time, never throws, never alters a write.
 *    No verdict in time is silence.
 */
import { dirname } from "node:path";
import { startLspClient, type DiagnosticsClient } from "./lsp-client.js";
import { formatNewErrors, newErrors } from "./lsp-delta.js";
import {
  findGitRoot,
  findOnPath,
  serverForPath,
  type LspServerSpec,
} from "./lsp-servers.js";

/** How long one file sync may wait for the server's diagnostics. */
export const LSP_DIAGNOSTICS_TIMEOUT_MS = 3000;
/** How long an edit waits for a server that is still starting. */
export const LSP_STARTUP_WAIT_MS = 5000;
/** How long the `initialize` handshake may take before the server is dropped. */
export const LSP_INITIALIZE_TIMEOUT_MS = 30_000;

export interface LspChangeInput {
  readonly absolute: string;
  /** The path as the model reads it (`displayPath`). */
  readonly display: string;
  readonly change: "write" | "edit" | "patch";
  /** The file before the change; omitted when new or unknown. */
  readonly before?: string;
  readonly after: string;
  /** The session making the change, for the start question. */
  readonly sessionId?: string;
  /** The tool call's signal; aborting it drops the start question. */
  readonly signal?: AbortSignal;
}

/** What the start question is about. */
export interface LspStartQuestion {
  /** The git work tree the server would treat as its workspace. */
  readonly root: string;
  /** The server about to start, as the operator knows it. */
  readonly server: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/**
 * The operator's answer: `yes` / `no` from a person, `unanswered` when
 * nobody could be asked (refuse policy, no window, timeout, abort).
 */
export type LspStartAnswer = "yes" | "no" | "unanswered";

export interface LspDiagnostics {
  /** The warning block for the tool result, or null. Never throws. */
  diagnoseChange(input: LspChangeInput): Promise<string | null>;
  /** Stops every server this instance started. */
  dispose(): void;
}

export type StartClient = (
  spec: LspServerSpec,
  binary: string,
  rootDir: string,
) => Promise<DiagnosticsClient>;

export interface LspDiagnosticsOptions {
  /** `tools.lsp.enabled`; false makes every call a no-op. */
  readonly enabled: boolean;
  /** Test seams; the defaults are the real PATH, git and process. */
  readonly findBinary?: (command: string) => string | null;
  readonly findRoot?: (dir: string) => string | null;
  readonly startClient?: StartClient;
  readonly diagnosticsTimeoutMs?: number;
  readonly startupWaitMs?: number;
  /**
   * Whether the operator trusts the folder (project folder trust,
   * `skills.projectTrust`). A trusted work tree starts without a
   * question. Omitted with `askToStart` set: nothing is trusted.
   */
  readonly isTrustedProject?: (root: string) => boolean;
  /**
   * Asks the operator before the first start in an untrusted work tree.
   * Omitted (embedders, tests of the old behaviour): servers start
   * without asking.
   */
  readonly askToStart?: (question: LspStartQuestion) => Promise<LspStartAnswer>;
}

interface ServerEntry {
  state: "starting" | "ready" | "failed";
  /** Resolves to the client, or null when the server could not start. */
  ready: Promise<DiagnosticsClient | null>;
  client: DiagnosticsClient | null;
  /** One sync at a time per server: before/after pairs must not interleave. */
  queue: Promise<unknown>;
}

type Entry = { readonly state: "unavailable" } | ServerEntry;

const UNAVAILABLE: Entry = { state: "unavailable" };

const defaultStartClient: StartClient = (spec, binary, rootDir) =>
  startLspClient({
    binary,
    args: spec.args,
    rootDir,
    initializeTimeoutMs: LSP_INITIALIZE_TIMEOUT_MS,
  });

export function createLspDiagnostics(
  options: LspDiagnosticsOptions,
): LspDiagnostics {
  const findBinary = options.findBinary ?? ((command) => findOnPath(command));
  const findRoot = options.findRoot ?? ((dir) => findGitRoot(dir));
  const startClient = options.startClient ?? defaultStartClient;
  const timeoutMs = options.diagnosticsTimeoutMs ?? LSP_DIAGNOSTICS_TIMEOUT_MS;
  const startupWaitMs = options.startupWaitMs ?? LSP_STARTUP_WAIT_MS;
  const binaries = new Map<string, string | null>();
  const entries = new Map<string, Entry>();
  /** A person's answer per work tree, kept for this process. */
  const startAnswers = new Map<string, boolean>();
  /** A question on screen, shared by edits that arrive meanwhile. */
  const asking = new Map<string, Promise<boolean>>();

  /**
   * May a server start in `root`? Trusted folders and earlier answers
   * decide at once; otherwise the operator is asked once per work tree.
   * Only a person's yes or no is remembered, so a session that could not
   * ask does not stop a later one with a window from asking.
   */
  const mayStart = (
    spec: LspServerSpec,
    root: string,
    input: LspChangeInput,
  ): Promise<boolean> => {
    const ask = options.askToStart;
    if (ask === undefined) return Promise.resolve(true);
    const known = startAnswers.get(root);
    if (known !== undefined) return Promise.resolve(known);
    if (options.isTrustedProject?.(root) === true) return Promise.resolve(true);
    if (input.sessionId === undefined) return Promise.resolve(false);
    const pending = asking.get(root);
    if (pending !== undefined) return pending;
    const question = ask({
      root,
      server: spec.command,
      sessionId: input.sessionId,
      signal: input.signal ?? new AbortController().signal,
    }).then(
      (answer) => {
        if (answer !== "unanswered") startAnswers.set(root, answer === "yes");
        return answer === "yes";
      },
      () => false,
    );
    const shared = question.finally(() => asking.delete(root));
    asking.set(root, shared);
    return shared;
  };

  const binaryFor = (command: string): string | null => {
    if (!binaries.has(command)) binaries.set(command, findBinary(command));
    return binaries.get(command) ?? null;
  };

  const entryFor = (spec: LspServerSpec, root: string): Entry => {
    const key = `${spec.id}\u0000${root}`;
    const existing = entries.get(key);
    if (existing !== undefined) {
      // A server that died is started again on the next edit.
      if (existing.state === "ready" && existing.client?.alive === false) {
        entries.delete(key);
      } else {
        return existing;
      }
    }
    const binary = binaryFor(spec.command);
    if (binary === null) {
      entries.set(key, UNAVAILABLE);
      return UNAVAILABLE;
    }
    const entry: ServerEntry = {
      state: "starting",
      client: null,
      queue: Promise.resolve(),
      ready: Promise.resolve(null),
    };
    entry.ready = startClient(spec, binary, root).then(
      (client) => {
        entry.client = client;
        entry.state = "ready";
        return client;
      },
      () => {
        // Not retried: a server that cannot start in this repository
        // would cost every later edit the same wait.
        entry.state = "failed";
        return null;
      },
    );
    entries.set(key, entry);
    return entry;
  };

  const run = async (input: LspChangeInput): Promise<string | null> => {
    const spec = serverForPath(input.absolute);
    if (spec === null) return null;
    const root = findRoot(dirname(input.absolute));
    if (root === null) return null;
    const known = entries.get(`${spec.id}\u0000${root}`);
    if (known === undefined || known.state === "unavailable") {
      // No server on PATH: nothing to ask about.
      if (binaryFor(spec.command) === null) return null;
      if (!(await mayStart(spec, root, input))) return null;
    }
    const entry = entryFor(spec, root);
    if (entry.state === "unavailable" || entry.state === "failed") return null;
    const client = await withTimeout(entry.ready, startupWaitMs);
    if (client === null || !client.alive) return null;
    const languageId = spec.languageId(input.absolute);
    const job = entry.queue.then(async () => {
      const before =
        input.before === undefined
          ? []
          : await client.diagnose(input.absolute, languageId, input.before, timeoutMs);
      if (before === null) return null;
      const after = await client.diagnose(
        input.absolute,
        languageId,
        input.after,
        timeoutMs,
      );
      if (after === null) return null;
      return formatNewErrors(
        input.display,
        input.change,
        spec.id,
        newErrors(before, after),
      );
    });
    entry.queue = job.catch(() => null);
    return job;
  };

  return {
    async diagnoseChange(input) {
      if (!options.enabled) return null;
      try {
        return await run(input);
      } catch {
        return null;
      }
    },
    dispose() {
      for (const entry of entries.values()) {
        if (entry.state === "unavailable") continue;
        void entry.ready.then((client) => client?.dispose());
      }
      entries.clear();
    },
  };
}

/** `promise`'s value, or null when it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
