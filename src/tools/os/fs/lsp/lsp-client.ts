/**
 * One language server as a child process, speaking LSP over stdio, used
 * for "here is the file's text, what errors do you see?" and, through
 * `sync` + `request`, for the navigation of `os.code.lsp` (ATO-2373).
 *
 * The client opens a document with the text it is given (or sends the
 * full new text as a change) and waits for the server's
 * `textDocument/publishDiagnostics` for it. Servers send those on their
 * own schedule and sometimes twice (syntax first, types after), so the
 * wait settles for a moment after each one and keeps the latest.
 *
 * typescript-language-server sends the quick syntax-only result first
 * and the type errors (TS2322 and friends) up to a second later, both
 * without a version. A short settle would take the empty syntax pass as
 * the verdict, so a publish without a version settles for
 * DIAGNOSTICS_UNVERSIONED_SETTLE_MS; one that names the version it is
 * for settles for the short DIAGNOSTICS_SETTLE_MS. A publish naming an
 * older version (a late answer to the "before" sync) is ignored. All of
 * it stays inside the caller's overall `timeoutMs`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCommandEnv } from "../../../../sandbox/command-env.js";
import { LSP_CLIENT_CAPABILITIES } from "./lsp-capabilities.js";
import type { LspDiagnostic } from "./lsp-delta.js";
import { PublishedDiagnosticsStore, type PublishedDiagnostics } from "./lsp-published.js";
import {
  createJsonRpcConnection,
  type JsonRpcConnection,
} from "./lsp-jsonrpc.js";

/** What the diagnostics layer needs from a server; tests pass a fake. */
export interface DiagnosticsClient {
  /**
   * The server's errors for the file at `path` holding `text`, or null
   * when it gave no verdict within `timeoutMs` (or has died).
   */
  diagnose(
    path: string,
    languageId: string,
    text: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null>;
  /**
   * Makes the server's copy of `path` hold `text` (open or full change),
   * without waiting for diagnostics. Optional: fakes may leave it out.
   */
  sync?(path: string, languageId: string, text: string): void;
  /**
   * The latest diagnostics the server published, per file, for `@problems`
   * (ATO-2472). Optional: fakes may leave it out.
   */
  published?(): readonly PublishedDiagnostics[];
  /** A plain LSP request (`textDocument/definition`, …), for navigation. */
  request?<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  readonly alive: boolean;
  dispose(): void;
}

/**
 * Quiet time after a publish that names the version it is for, before
 * its result is taken as final.
 */
export const DIAGNOSTICS_SETTLE_MS = 300;
/**
 * Quiet time after a publish without a version: long enough for the
 * semantic pass that follows a syntax-only one.
 */
export const DIAGNOSTICS_UNVERSIONED_SETTLE_MS = 1500;

interface OpenDoc {
  version: number;
  text: string;
  diagnostics: LspDiagnostic[] | null;
}

interface Waiter {
  version: number;
  latest: LspDiagnostic[] | null;
  settle: ReturnType<typeof setTimeout> | null;
  finish(value: LspDiagnostic[] | null): void;
}

export interface StartLspClientOptions {
  /** Absolute path of the server binary (found on PATH). */
  readonly binary: string;
  readonly args: readonly string[];
  /** The git work tree the server treats as its workspace. */
  readonly rootDir: string;
  readonly initializeTimeoutMs: number;
}

/** Wraps a live connection; exported for tests that drive it with streams. */
export class LspConnectionClient implements DiagnosticsClient {
  private readonly docs = new Map<string, OpenDoc>();
  private readonly waiters = new Map<string, Waiter>();
  /** Every publish, waited for or not (ATO-2472). */
  private readonly publishedStore = new PublishedDiagnosticsStore();

  constructor(
    private readonly connection: JsonRpcConnection,
    private readonly onDispose: () => void = () => {},
  ) {
    connection.onNotification((method, params) => {
      if (method === "textDocument/publishDiagnostics") this.onPublish(params);
    });
  }

  get alive(): boolean {
    return !this.connection.disposed;
  }

  async initialize(rootDir: string, timeoutMs: number): Promise<void> {
    const rootUri = pathToFileURL(rootDir).href;
    await this.connection.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(rootDir) }],
        capabilities: LSP_CLIENT_CAPABILITIES,
        initializationOptions: {},
      },
      timeoutMs,
    );
    this.connection.notify("initialized", {});
  }

  diagnose(
    path: string,
    languageId: string,
    text: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    if (!this.alive) return Promise.resolve(null);
    const uri = pathToFileURL(path).href;
    const key = uriKey(uri);
    const doc = this.docs.get(key);
    // Same text as last time: the server has nothing new to say and may
    // stay silent, so the last answer stands.
    if (doc !== undefined && doc.text === text && doc.diagnostics !== null) {
      return Promise.resolve(doc.diagnostics);
    }
    const version = (doc?.version ?? 0) + 1;
    const next: OpenDoc = { version, text, diagnostics: null };
    this.docs.set(key, next);
    const result = this.waitFor(key, version, timeoutMs).then((found) => {
      if (this.docs.get(key) === next) next.diagnostics = found;
      return found;
    });
    if (doc === undefined) {
      this.connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      this.connection.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return result;
  }

  sync(path: string, languageId: string, text: string): void {
    if (!this.alive) return;
    const uri = pathToFileURL(path).href;
    const key = uriKey(uri);
    const doc = this.docs.get(key);
    if (doc !== undefined && doc.text === text) return;
    const version = (doc?.version ?? 0) + 1;
    this.docs.set(key, { version, text, diagnostics: null });
    if (doc === undefined) {
      this.connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      this.connection.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return this.connection.request<T>(method, params, timeoutMs);
  }

  published(): readonly PublishedDiagnostics[] {
    return this.publishedStore.list();
  }

  dispose(): void {
    for (const waiter of this.waiters.values()) waiter.finish(waiter.latest);
    this.waiters.clear();
    // No shutdown handshake: the server holds nothing worth saving, and
    // the process owner kills it right after.
    this.connection.dispose("LSP client disposed");
    this.onDispose();
  }

  private waitFor(
    key: string,
    version: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    this.waiters.get(key)?.finish(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        version,
        latest: null,
        settle: null,
        finish: (value) => {
          clearTimeout(deadline);
          if (waiter.settle !== null) clearTimeout(waiter.settle);
          if (this.waiters.get(key) === waiter) this.waiters.delete(key);
          resolve(value);
        },
      };
      const deadline = setTimeout(() => waiter.finish(waiter.latest), timeoutMs);
      this.waiters.set(key, waiter);
    });
  }

  private onPublish(params: unknown): void {
    const p = params as {
      uri?: string;
      version?: number;
      diagnostics?: unknown;
    } | null;
    if (typeof p?.uri !== "string" || !Array.isArray(p.diagnostics)) return;
    const key = uriKey(p.uri);
    const diagnostics = p.diagnostics.filter(
      (d): d is LspDiagnostic =>
        d !== null &&
        typeof d === "object" &&
        typeof (d as { message?: unknown }).message === "string",
    );
    this.publishedStore.remember(key, p.uri, diagnostics);
    const waiter = this.waiters.get(key);
    if (waiter === undefined) return;
    const versioned = typeof p.version === "number";
    // A server that tracks versions tells us when a publish is stale:
    // a late answer to the "before" sync never counts for the "after" one.
    if (versioned && (p.version as number) < waiter.version) return;
    waiter.latest = diagnostics;
    if (waiter.settle !== null) clearTimeout(waiter.settle);
    // Without a version the publish may be the syntax-only pass with the
    // type errors still to come, so wait longer for a later one.
    waiter.settle = setTimeout(
      () => waiter.finish(waiter.latest),
      versioned ? DIAGNOSTICS_SETTLE_MS : DIAGNOSTICS_UNVERSIONED_SETTLE_MS,
    );
  }
}

/**
 * Servers echo a document URI in their own spelling (`file:///c%3A/…`
 * for `file:///C:/…` on Windows), so URIs are compared decoded, and
 * without case on Windows.
 */
export function uriKey(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // A malformed escape: compare as sent.
  }
  return platform === "win32" ? decoded.toLowerCase() : decoded;
}

/**
 * Spawn the server and run the LSP handshake. Rejects when the binary
 * cannot start or does not answer `initialize` in time; the child is
 * killed then. The child never keeps the agent's process alive, and it
 * dies with it.
 */
export async function startLspClient(
  options: StartLspClientOptions,
): Promise<DiagnosticsClient> {
  const child = spawnServer(options);
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.once("exit", kill);
  const forget = (): void => {
    process.removeListener("exit", kill);
    kill();
  };
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    forget();
    throw new Error("LSP server started without stdio pipes");
  }
  const connection = createJsonRpcConnection(stdout, stdin);
  const client = new LspConnectionClient(connection, forget);
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => reject(new Error(`LSP server exited (${code})`)));
  });
  failed.catch(() => {});
  child.once("exit", () => {
    process.removeListener("exit", kill);
    connection.dispose("LSP server exited");
  });
  child.unref();
  // Pipes are sockets: unreferenced, an idle server never holds the
  // agent's event loop open. A pending wait still does (its timer).
  (stdout as { unref?: () => void }).unref?.();
  (stdin as { unref?: () => void }).unref?.();
  try {
    await Promise.race([
      client.initialize(options.rootDir, options.initializeTimeoutMs),
      failed,
    ]);
  } catch (err) {
    client.dispose();
    throw err;
  }
  return client;
}

function spawnServer(options: StartLspClientOptions): ChildProcess {
  // npm installs a `.cmd` shim on Windows, which only a shell can run.
  const shell =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(options.binary);
  const command = shell ? `"${options.binary}"` : options.binary;
  return spawn(command, [...options.args], {
    cwd: options.rootDir,
    // The agent's provider keys and tokens stay out of the server.
    env: buildCommandEnv(process.env),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell,
  });
}
