import { connect as tlsConnect } from "node:tls";

import {
  ImapProtocolError,
  ImapResponseReader,
  quoteImapString,
  responseCode,
  type ImapResponse,
} from "./imap-response.js";

/**
 * A small IMAP4rev1 client (RFC 3501) on Node's `tls`, for the mail
 * trigger (ATO-601) and nothing else: log in (LOGIN or SASL XOAUTH2),
 * SELECT one folder, UID SEARCH, UID FETCH, set `\Seen`, and wait for
 * new mail with IDLE (RFC 2177). One command at a time; no pipelining.
 *
 * The socket is behind {@link ImapTransport} so tests drive the client
 * with a fake server instead of a network.
 */

export interface ImapTransport {
  write(data: string | Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: (err?: Error) => void): void;
  close(): void;
}

export interface ImapSelectResult {
  uidValidity: number;
  uidNext: number | null;
  exists: number;
}

export interface ImapFetchItem {
  uid: number;
  size: number | null;
  /** The first literal in the FETCH response (the body section asked for). */
  body: Buffer | null;
}

export interface ImapTaggedResult {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: ImapResponse[];
}

export type ImapIdleOutcome = "new-mail" | "timeout" | "aborted";

export class ImapCommandError extends Error {
  override readonly name = "ImapCommandError";
  constructor(
    readonly command: string,
    readonly status: string,
    text: string,
  ) {
    super(`IMAP ${command} failed: ${status} ${text}`.trim());
  }
}

export interface ImapClientOptions {
  /** Per command; a FETCH of a large mail has the same budget. */
  commandTimeoutMs?: number;
  /** Largest literal accepted from the server (one whole mail). */
  maxLiteralBytes?: number;
}

/** A piece of a command: plain text, or bytes sent as an IMAP literal. */
type CommandPart = string | { literal: Buffer };

interface Pending {
  tag: string;
  name: string;
  untagged: ImapResponse[];
  /** Literals still to send, each after a `+` from the server. */
  literals: Buffer[];
  rest: string[];
  onContinue?: (text: string) => string | null;
  onUntagged?: (r: ImapResponse) => void;
  resolve: (r: ImapTaggedResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_LITERAL_BYTES = 80 * 1024 * 1024;

export class ImapClient {
  private readonly reader: ImapResponseReader;
  private readonly timeoutMs: number;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private closed: Error | null = null;
  private greeting: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private greeted: Promise<void>;
  private caps = new Set<string>();
  private authenticated = false;

  constructor(
    private readonly transport: ImapTransport,
    options: ImapClientOptions = {},
  ) {
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.reader = new ImapResponseReader(options.maxLiteralBytes ?? DEFAULT_MAX_LITERAL_BYTES);
    this.greeted = new Promise<void>((resolve, reject) => {
      this.greeting = { resolve, reject };
    });
    // A greeting nobody waits on yet must not be an unhandled rejection.
    this.greeted.catch(() => undefined);
    transport.onData((chunk) => this.onData(chunk));
    transport.onClose((err) => this.onClosed(err ?? new Error("IMAP connection closed")));
  }

  /** Capabilities the server announced (upper-case). */
  has(capability: string): boolean {
    return this.caps.has(capability.toUpperCase());
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  /** Waits for the server greeting; a `BYE` greeting rejects. */
  async ready(timeoutMs = this.timeoutMs): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.greeted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("IMAP greeting timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.caps.size === 0) await this.capability();
  }

  async capability(): Promise<void> {
    await this.run("CAPABILITY", ["CAPABILITY"]);
  }

  async login(user: string, password: string): Promise<void> {
    const parts: CommandPart[] = ["LOGIN ", ...astring(user), " ", ...astring(password)];
    await this.run("LOGIN", parts);
    this.authenticated = true;
    await this.refreshCapabilitiesAfterAuth();
  }

  /** SASL XOAUTH2 (Google, Microsoft) with an access token the operator supplies. */
  async authenticateXoauth2(user: string, token: string): Promise<void> {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(user + token)) throw new Error("XOAUTH2 user or token has control characters");
    const blob = Buffer.from(`user=${user}\u0001auth=Bearer ${token}\u0001\u0001`, "utf8").toString("base64");
    const inline = this.has("SASL-IR");
    let sent = inline;
    await this.run("AUTHENTICATE", [inline ? `AUTHENTICATE XOAUTH2 ${blob}` : "AUTHENTICATE XOAUTH2"], {
      // Without SASL-IR the first `+` asks for the blob. After a failure
      // the server sends a JSON error as a challenge; an empty line ends it.
      onContinue: () => {
        if (!sent) {
          sent = true;
          return blob;
        }
        return "";
      },
    });
    this.authenticated = true;
    await this.refreshCapabilitiesAfterAuth();
  }

  async select(mailbox: string): Promise<ImapSelectResult> {
    const result = await this.run("SELECT", [`SELECT ${quoteImapString(mailbox)}`]);
    let uidValidity: number | null = null;
    let uidNext: number | null = null;
    let exists = 0;
    for (const r of result.untagged) {
      const code = responseCode(r.text);
      if (code?.code === "UIDVALIDITY") uidValidity = Number(code.args);
      if (code?.code === "UIDNEXT") uidNext = Number(code.args);
      const m = /^(\d+) EXISTS$/i.exec(r.text);
      if (m) exists = Number(m[1]);
    }
    if (uidValidity === null || !Number.isFinite(uidValidity)) {
      throw new ImapProtocolError("SELECT gave no UIDVALIDITY");
    }
    return { uidValidity, uidNext: Number.isFinite(uidNext) ? uidNext : null, exists };
  }

  /** `UID SEARCH <criteria>`; the criteria are built by the caller from numbers and keywords only. */
  async uidSearch(criteria: string): Promise<number[]> {
    const result = await this.run("SEARCH", [`UID SEARCH ${criteria}`]);
    const uids: number[] = [];
    for (const r of result.untagged) {
      const m = /^SEARCH\b(.*)$/i.exec(r.text);
      if (!m) continue;
      for (const token of m[1]!.trim().split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(Number(token));
      }
    }
    return uids;
  }

  /** `UID FETCH <set> <items>`, keyed by UID. */
  async uidFetch(uids: readonly number[], items: string): Promise<Map<number, ImapFetchItem>> {
    const out = new Map<number, ImapFetchItem>();
    if (uids.length === 0) return out;
    const result = await this.run("FETCH", [`UID FETCH ${uids.join(",")} ${items}`]);
    for (const r of result.untagged) {
      if (!/^\d+ FETCH\b/i.test(r.text)) continue;
      const uid = /\bUID (\d+)/i.exec(r.text);
      if (!uid) continue;
      const size = /\bRFC822\.SIZE (\d+)/i.exec(r.text);
      out.set(Number(uid[1]), {
        uid: Number(uid[1]),
        size: size ? Number(size[1]) : null,
        body: r.literals[0] ?? null,
      });
    }
    return out;
  }

  async markSeen(uids: readonly number[]): Promise<void> {
    if (uids.length === 0) return;
    await this.run("STORE", [`UID STORE ${uids.join(",")} +FLAGS.SILENT (\\Seen)`]);
  }

  /**
   * IDLE until the folder gains mail (`EXISTS` or `RECENT`), `timeoutMs`
   * passes, or `signal` aborts; then `DONE`. RFC 2177 asks clients to
   * re-issue IDLE at least every 29 minutes.
   */
  async idle(timeoutMs: number, signal?: AbortSignal): Promise<ImapIdleOutcome> {
    if (!this.has("IDLE")) throw new ImapProtocolError("server does not support IDLE");
    if (signal?.aborted) return "aborted";
    let outcome: ImapIdleOutcome = "timeout";
    let done = false;
    let idling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (why: ImapIdleOutcome) => {
      if (done) return;
      done = true;
      outcome = why;
      if (timer) clearTimeout(timer);
      if (idling && !this.closed) this.transport.write("DONE\r\n");
    };
    const onAbort = () => finish("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // The budget covers the wait plus a normal command's worth for the
      // `+` and the tagged OK after DONE, so a silent dead line fails.
      await this.run("IDLE", ["IDLE"], {
        timeoutMs: timeoutMs + this.timeoutMs,
        onContinue: () => {
          idling = true;
          if (done) {
            // Ended before the server said `+ idling`: leave at once.
            this.transport.write("DONE\r\n");
          } else {
            timer = setTimeout(() => finish("timeout"), timeoutMs);
          }
          return null;
        },
        onUntagged: (r) => {
          if (/^\d+ (EXISTS|RECENT)$/i.test(r.text)) finish("new-mail");
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    return outcome;
  }

  /** Best effort; always closes the socket. */
  async logout(): Promise<void> {
    if (!this.closed) {
      try {
        await this.run("LOGOUT", ["LOGOUT"], { timeoutMs: 5_000 });
      } catch {
        // The server may drop the line before the tagged OK.
      }
    }
    this.close();
  }

  close(): void {
    if (!this.closed) this.onClosed(new Error("IMAP connection closed by the client"));
    this.transport.close();
  }

  private async refreshCapabilitiesAfterAuth(): Promise<void> {
    // Servers often announce more (IDLE among them) once logged in.
    if (!this.has("IDLE")) await this.capability();
  }

  private run(
    name: string,
    parts: CommandPart[],
    options: {
      onContinue?: (text: string) => string | null;
      onUntagged?: (r: ImapResponse) => void;
      timeoutMs?: number;
    } = {},
  ): Promise<ImapTaggedResult> {
    const next = this.queue.then(() => this.send(name, parts, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private send(
    name: string,
    parts: CommandPart[],
    options: {
      onContinue?: (text: string) => string | null;
      onUntagged?: (r: ImapResponse) => void;
      timeoutMs?: number;
    },
  ): Promise<ImapTaggedResult> {
    if (this.closed) return Promise.reject(this.closed);
    if (name !== "CAPABILITY" && name !== "LOGOUT" && !this.authenticated && name !== "LOGIN" && name !== "AUTHENTICATE") {
      return Promise.reject(new Error(`IMAP ${name} before login`));
    }
    this.seq += 1;
    const tag = `A${this.seq}`;
    // Split the command at its literals: text up to and including the
    // `{n}` marker goes now, each literal after the server's `+`.
    const chunks: string[] = [];
    const literals: Buffer[] = [];
    let text = `${tag} `;
    for (const part of parts) {
      if (typeof part === "string") {
        text += part;
      } else {
        chunks.push(`${text}{${part.literal.length}}\r\n`);
        literals.push(part.literal);
        text = "";
      }
    }
    chunks.push(`${text}\r\n`);
    return new Promise<ImapTaggedResult>((resolve, reject) => {
      const pending: Pending = {
        tag,
        name,
        untagged: [],
        literals,
        rest: chunks.slice(1),
        ...(options.onContinue ? { onContinue: options.onContinue } : {}),
        ...(options.onUntagged ? { onUntagged: options.onUntagged } : {}),
        resolve,
        reject,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        this.fail(new Error(`IMAP ${name} timed out`));
      }, options.timeoutMs ?? this.timeoutMs);
      this.pending = pending;
      this.transport.write(chunks[0]!);
    });
  }

  private onData(chunk: Buffer): void {
    let responses: ImapResponse[];
    try {
      responses = this.reader.push(chunk);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const r of responses) this.handle(r);
  }

  private handle(r: ImapResponse): void {
    if (this.greeting) {
      const greeting = this.greeting;
      this.greeting = null;
      if (r.tag === "*" && /^(OK|PREAUTH)\b/i.test(r.text)) {
        if (/^PREAUTH\b/i.test(r.text)) this.authenticated = true;
        this.readCapabilities(r.text);
        greeting.resolve();
      } else {
        greeting.reject(new ImapCommandError("greeting", "BYE", r.text));
        this.fail(new Error(`IMAP server refused the connection: ${r.text}`));
      }
      return;
    }
    const pending = this.pending;
    if (r.tag === "+") {
      if (!pending) return;
      const literal = pending.literals.shift();
      if (literal) {
        this.transport.write(literal);
        const more = pending.rest.shift();
        if (more) this.transport.write(more);
        return;
      }
      const reply = pending.onContinue?.(r.text) ?? null;
      if (reply !== null) this.transport.write(`${reply}\r\n`);
      return;
    }
    if (r.tag === "*") {
      this.readCapabilities(r.text);
      if (/^BYE\b/i.test(r.text) && pending?.name !== "LOGOUT") {
        // The server is closing; the socket close that follows fails the command.
        return;
      }
      if (pending) {
        pending.untagged.push(r);
        pending.onUntagged?.(r);
      }
      return;
    }
    if (!pending || r.tag !== pending.tag) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    this.readCapabilities(r.text);
    const status = /^(OK|NO|BAD)\b/i.exec(r.text)?.[1]?.toUpperCase() as ImapTaggedResult["status"] | undefined;
    const text = r.text.replace(/^(OK|NO|BAD)\s*/i, "");
    if (status === "OK") pending.resolve({ status, text, untagged: pending.untagged });
    else pending.reject(new ImapCommandError(pending.name, status ?? "BAD", text));
  }

  private readCapabilities(text: string): void {
    const fromCode = responseCode(text);
    const list =
      fromCode?.code === "CAPABILITY"
        ? fromCode.args
        : /^CAPABILITY\s+(.*)$/i.exec(text)?.[1];
    if (list === undefined) return;
    this.caps = new Set(list.trim().split(/\s+/).map((c) => c.toUpperCase()));
  }

  private fail(err: Error): void {
    this.onClosed(err);
    this.transport.close();
  }

  private onClosed(err: Error): void {
    if (this.closed) return;
    this.closed = err;
    if (this.greeting) {
      this.greeting.reject(err);
      this.greeting = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.name === "LOGOUT") pending.resolve({ status: "OK", text: "", untagged: pending.untagged });
      else pending.reject(err);
    }
  }
}

/** A quoted string for 7-bit text, else a literal (UTF-8 passwords). */
function astring(value: string): CommandPart[] {
  return /^[\x20-\x7e]*$/.test(value) ? [quoteImapString(value)] : [{ literal: Buffer.from(value, "utf8") }];
}

/** A TLS socket to `host:port` as an {@link ImapTransport}; resolves once the handshake is done. */
export function connectImapTls(
  host: string,
  port: number,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ImapTransport> {
  return new Promise((resolve, reject) => {
    // Certificate checks stay on (Node's default); `servername` for SNI.
    const socket = tlsConnect({ host, port, servername: host });
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IMAP connect to ${host}:${port} timed out`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("IMAP connect aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // A half-open line (NAT, sleep) shows up as silence: let the
      // keepalive find it, and give the socket its own error sink.
      socket.setKeepAlive(true, 60_000);
      socket.removeAllListeners("error");
      let closeListener: ((err?: Error) => void) | null = null;
      let lastError: Error | undefined;
      socket.on("error", (err) => {
        lastError = err;
      });
      socket.on("close", () => closeListener?.(lastError));
      resolve({
        write: (data) => {
          socket.write(data);
        },
        onData: (listener) => {
          socket.on("data", listener);
        },
        onClose: (listener) => {
          closeListener = listener;
        },
        close: () => {
          socket.destroy();
        },
      });
    });
  });
}
