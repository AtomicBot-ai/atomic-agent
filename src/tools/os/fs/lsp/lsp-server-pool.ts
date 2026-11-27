/**
 * The language servers of one agent process (ATO-503, shared since
 * ATO-2373): one per language per git work tree, started lazily on the
 * first use, reused by the after-edit diagnostics and by `os.code.lsp`.
 *
 * Rules, all of them on purpose:
 *  - only inside a git work tree, never at home or a filesystem root,
 *    so no daemon starts for a stray file in Downloads;
 *  - only servers already on PATH; nothing is ever installed;
 *  - a language server runs the project's own code (tsconfig plugins, a
 *    local TypeScript, pyright's environment, a Go module's tooling),
 *    so in a folder the operator has not trusted the first start asks
 *    once for the work tree and the answer is kept for it; no answer (a
 *    surface without a window, a refuse policy) starts nothing;
 *  - a server that cannot start is not retried; one that died is
 *    started again on the next use;
 *  - one job at a time per server, so a diagnostics before/after pair
 *    and a navigation request never interleave on one document.
 */
import { dirname } from "node:path";
import { startLspClient, type DiagnosticsClient } from "./lsp-client.js";
import {
  findGitRoot,
  findOnPath,
  serverArgs,
  serverForPath,
  type LspServerSpec,
} from "./lsp-servers.js";

/** How long the `initialize` handshake may take before the server is dropped. */
export const LSP_INITIALIZE_TIMEOUT_MS = 30_000;

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

export type StartClient = (
  spec: LspServerSpec,
  binary: string,
  rootDir: string,
) => Promise<DiagnosticsClient>;

export interface LspServerPoolOptions {
  /** Test seams; the defaults are the real PATH, git and process. */
  readonly findBinary?: (command: string) => string | null;
  readonly findRoot?: (dir: string) => string | null;
  readonly startClient?: StartClient;
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

/** Who is asking, for the start question. */
export interface LspAccess {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

/** Why no server ran the job. */
export type LspUnavailable =
  | "no_language"
  | "no_project"
  | "not_installed"
  | "declined"
  | "failed"
  | "starting";

export interface LspServer {
  readonly client: DiagnosticsClient;
  readonly spec: LspServerSpec;
  readonly root: string;
}

export type LspPoolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: LspUnavailable; readonly spec?: LspServerSpec };

export interface LspServerPool {
  /**
   * Runs `job` on the server for `absolute`, after every earlier job on
   * that server. Waits at most `startupWaitMs` for a server still
   * starting. A job's own error rejects the returned promise.
   */
  withServer<T>(
    absolute: string,
    access: LspAccess,
    startupWaitMs: number,
    job: (server: LspServer) => Promise<T>,
  ): Promise<LspPoolResult<T>>;
  /**
   * The servers up right now, for `@problems` (ATO-2472). Starts
   * nothing and asks nothing.
   */
  running(): LspServer[];
  /** Stops every server this pool started. */
  dispose(): void;
}

interface ServerEntry {
  state: "starting" | "ready" | "failed";
  readonly spec: LspServerSpec;
  readonly root: string;
  /** Resolves to the client, or null when the server could not start. */
  ready: Promise<DiagnosticsClient | null>;
  client: DiagnosticsClient | null;
  queue: Promise<unknown>;
}

type Entry = { readonly state: "unavailable" } | ServerEntry;

const UNAVAILABLE: Entry = { state: "unavailable" };

const defaultStartClient: StartClient = (spec, binary, rootDir) =>
  startLspClient({
    binary,
    args: serverArgs(spec, rootDir),
    rootDir,
    initializeTimeoutMs: LSP_INITIALIZE_TIMEOUT_MS,
  });

export function createLspServerPool(options: LspServerPoolOptions = {}): LspServerPool {
  const findBinary = options.findBinary ?? ((command) => findOnPath(command));
  const findRoot = options.findRoot ?? ((dir) => findGitRoot(dir));
  const startClient = options.startClient ?? defaultStartClient;
  const binaries = new Map<string, string | null>();
  const entries = new Map<string, Entry>();
  /** A person's answer per work tree, kept for this process. */
  const startAnswers = new Map<string, boolean>();
  /** A question on screen, shared by uses that arrive meanwhile. */
  const asking = new Map<string, Promise<boolean>>();

  /**
   * May a server start in `root`? Trusted folders and earlier answers
   * decide at once; otherwise the operator is asked once per work tree.
   * Only a person's yes or no is remembered, so a session that could not
   * ask does not stop a later one with a window from asking.
   */
  const mayStart = (spec: LspServerSpec, root: string, access: LspAccess): Promise<boolean> => {
    const ask = options.askToStart;
    if (ask === undefined) return Promise.resolve(true);
    const known = startAnswers.get(root);
    if (known !== undefined) return Promise.resolve(known);
    if (options.isTrustedProject?.(root) === true) return Promise.resolve(true);
    if (access.sessionId === undefined) return Promise.resolve(false);
    const pending = asking.get(root);
    if (pending !== undefined) return pending;
    const question = ask({
      root,
      server: spec.command,
      sessionId: access.sessionId,
      signal: access.signal ?? new AbortController().signal,
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
      // A server that died is started again on the next use.
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
      spec,
      root,
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
        // would cost every later use the same wait.
        entry.state = "failed";
        return null;
      },
    );
    entries.set(key, entry);
    return entry;
  };

  return {
    async withServer<T>(
      absolute: string,
      access: LspAccess,
      startupWaitMs: number,
      job: (server: LspServer) => Promise<T>,
    ): Promise<LspPoolResult<T>> {
      const spec = serverForPath(absolute);
      if (spec === null) return { ok: false, reason: "no_language" };
      const root = findRoot(dirname(absolute));
      if (root === null) return { ok: false, reason: "no_project", spec };
      const known = entries.get(`${spec.id}\u0000${root}`);
      if (known === undefined || known.state === "unavailable") {
        // No server on PATH: nothing to ask about.
        if (binaryFor(spec.command) === null) return { ok: false, reason: "not_installed", spec };
        if (!(await mayStart(spec, root, access))) return { ok: false, reason: "declined", spec };
      }
      const entry = entryFor(spec, root);
      if (entry.state === "unavailable") return { ok: false, reason: "not_installed", spec };
      if (entry.state === "failed") return { ok: false, reason: "failed", spec };
      const client = await withTimeout(entry.ready, startupWaitMs);
      if (client === null) {
        // Read the state again: it may have turned "failed" during the
        // wait, but TS keeps it narrowed by the early return above.
        const state: ServerEntry["state"] = (entry as ServerEntry).state;
        return { ok: false, reason: state === "failed" ? "failed" : "starting", spec };
      }
      if (!client.alive) return { ok: false, reason: "failed", spec };
      const run = entry.queue.then(() => job({ client, spec, root }));
      entry.queue = run.catch(() => null);
      return { ok: true, value: await run };
    },
    running() {
      const out: LspServer[] = [];
      for (const entry of entries.values()) {
        if (entry.state !== "ready" || entry.client === null || !entry.client.alive) continue;
        out.push({ client: entry.client, spec: entry.spec, root: entry.root });
      }
      return out;
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
