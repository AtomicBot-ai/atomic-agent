import type { ImapTransport } from "./imap-client.js";

/**
 * An in-memory IMAP server for the IMAP trigger's tests (ATO-601):
 * enough of RFC 3501 and RFC 2177 for what `ImapClient` sends (LOGIN,
 * AUTHENTICATE XOAUTH2, SELECT, UID SEARCH, UID FETCH, UID STORE, IDLE,
 * LOGOUT), answering in small chunks so the response reader is
 * exercised across split lines and literals. Test-only.
 */

export interface FakeMessage {
  uid: number;
  raw: string;
  seen: boolean;
}

export interface FakeImapServerOptions {
  user?: string;
  password?: string;
  token?: string;
  capabilities?: string[];
  /** Bytes per chunk the server writes; small to split lines and literals. */
  chunkSize?: number;
  uidValidity?: number;
  /** Leave UIDNEXT out of SELECT, as some servers do. */
  omitUidNext?: boolean;
}

export class FakeImapServer {
  readonly user: string;
  readonly password: string;
  readonly token: string;
  capabilities: string[];
  uidValidity: number;
  readonly omitUidNext: boolean;
  readonly chunkSize: number;
  readonly messages: FakeMessage[] = [];
  /** Every command line received, tag stripped, across connections. */
  readonly commands: string[] = [];
  readonly connections: FakeImapConnection[] = [];
  private nextUid = 1;

  constructor(options: FakeImapServerOptions = {}) {
    this.user = options.user ?? "me@example.com";
    this.password = options.password ?? "app-password";
    this.token = options.token ?? "ya29.token";
    this.capabilities = options.capabilities ?? ["IMAP4rev1", "IDLE", "SASL-IR", "AUTH=XOAUTH2"];
    this.chunkSize = options.chunkSize ?? 7;
    this.uidValidity = options.uidValidity ?? 42;
    this.omitUidNext = options.omitUidNext ?? false;
  }

  /** A new mail arrives; idling connections hear `EXISTS`. */
  deliver(raw: string, seen = false): number {
    const uid = this.nextUid++;
    this.messages.push({ uid, raw: raw.replace(/\r?\n/g, "\r\n"), seen });
    for (const c of this.connections) c.notifyExists();
    return uid;
  }

  connect(): ImapTransport {
    const conn = new FakeImapConnection(this);
    this.connections.push(conn);
    return conn;
  }

  get uidNext(): number {
    return this.nextUid;
  }

  get open(): FakeImapConnection[] {
    return this.connections.filter((c) => !c.closed);
  }
}

export class FakeImapConnection implements ImapTransport {
  closed = false;
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private closeListener: ((err?: Error) => void) | null = null;
  private inbound = Buffer.alloc(0);
  private literalNeed = 0;
  private lineParts: string[] = [];
  private idleTag: string | null = null;
  private selected = false;
  private loggedIn = false;
  private saslTag: string | null = null;
  private saslFailTag: string | null = null;

  constructor(private readonly server: FakeImapServer) {
    setImmediate(() => this.send(`* OK [CAPABILITY ${server.capabilities.join(" ")}] fake ready\r\n`));
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener;
  }

  onClose(listener: (err?: Error) => void): void {
    this.closeListener = listener;
  }

  write(data: string | Buffer): void {
    if (this.closed) return;
    this.inbound = Buffer.concat([this.inbound, typeof data === "string" ? Buffer.from(data, "utf8") : data]);
    this.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.closeListener?.());
  }

  /** Drops the line without a word, like a dead NAT mapping. */
  kill(): void {
    this.close();
  }

  notifyExists(): void {
    if (this.idleTag && this.selected) this.send(`* ${this.server.messages.length} EXISTS\r\n`);
  }

  private send(text: string | Buffer): void {
    if (this.closed) return;
    const bytes = typeof text === "string" ? Buffer.from(text, "latin1") : text;
    const size = this.server.chunkSize;
    for (let i = 0; i < bytes.length; i += size) {
      const piece = bytes.subarray(i, i + size);
      setImmediate(() => {
        if (!this.closed) this.dataListener?.(Buffer.from(piece));
      });
    }
  }

  private drain(): void {
    for (;;) {
      if (this.literalNeed > 0) {
        if (this.inbound.length < this.literalNeed) return;
        this.lineParts.push(this.inbound.subarray(0, this.literalNeed).toString("utf8"));
        this.inbound = this.inbound.subarray(this.literalNeed);
        this.literalNeed = 0;
        continue;
      }
      const end = this.inbound.indexOf("\r\n");
      if (end < 0) return;
      const line = this.inbound.subarray(0, end).toString("utf8");
      this.inbound = this.inbound.subarray(end + 2);
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        this.lineParts.push(line.slice(0, lit.index));
        this.literalNeed = Number(lit[1]);
        this.send("+ go ahead\r\n");
        continue;
      }
      this.lineParts.push(line);
      const full = this.lineParts.join("");
      this.lineParts = [];
      this.handle(full);
    }
  }

  private handle(line: string): void {
    if (this.idleTag) {
      if (line.trim().toUpperCase() === "DONE") {
        this.server.commands.push("DONE");
        const tag = this.idleTag;
        this.idleTag = null;
        this.send(`${tag} OK IDLE terminated\r\n`);
      }
      return;
    }
    if (this.saslFailTag) {
      const tag = this.saslFailTag;
      this.saslFailTag = null;
      this.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      return;
    }
    if (this.saslTag) {
      const tag = this.saslTag;
      this.saslTag = null;
      this.finishXoauth2(tag, line.trim());
      return;
    }
    const space = line.indexOf(" ");
    const tag = line.slice(0, space);
    const rest = line.slice(space + 1);
    this.server.commands.push(rest);
    const upper = rest.toUpperCase();
    const ok = (text = "done") => this.send(`${tag} OK ${text}\r\n`);
    if (upper === "CAPABILITY") {
      this.send(`* CAPABILITY ${this.server.capabilities.join(" ")}\r\n`);
      return ok();
    }
    if (upper.startsWith("LOGIN ")) {
      const args = parseAstrings(rest.slice(6));
      if (args[0] === this.server.user && args[1] === this.server.password) {
        this.loggedIn = true;
        return ok("LOGIN completed");
      }
      return this.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    }
    if (upper.startsWith("AUTHENTICATE XOAUTH2")) {
      const blob = rest.slice("AUTHENTICATE XOAUTH2".length).trim();
      if (blob) return this.finishXoauth2(tag, blob);
      this.saslTag = tag;
      return this.send("+ \r\n");
    }
    if (!this.loggedIn && upper !== "LOGOUT") return this.send(`${tag} BAD not logged in\r\n`);
    if (upper.startsWith("SELECT ")) {
      this.selected = true;
      const s = this.server;
      this.send(`* ${s.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${s.uidValidity}] ok\r\n`);
      if (!s.omitUidNext) this.send(`* OK [UIDNEXT ${s.uidNext}] next\r\n`);
      return ok("[READ-WRITE] SELECT completed");
    }
    if (upper.startsWith("UID SEARCH ")) {
      const criteria = upper.slice("UID SEARCH ".length);
      let found = this.server.messages;
      if (criteria.includes("UNSEEN")) found = found.filter((m) => !m.seen);
      const range = /UID (\d+):\*/.exec(criteria);
      if (range) {
        const from = Number(range[1]);
        const max = Math.max(0, ...this.server.messages.map((m) => m.uid));
        // RFC 3501: `n:*` always includes the highest UID.
        found = found.filter((m) => m.uid >= from || m.uid === max);
      }
      this.send(`* SEARCH${found.map((m) => ` ${m.uid}`).join("")}\r\n`);
      return ok();
    }
    if (upper.startsWith("UID FETCH ")) {
      const m = /^UID FETCH ([\d,]+) \((.*)\)$/i.exec(rest);
      if (!m) return this.send(`${tag} BAD fetch\r\n`);
      const uids = m[1]!.split(",").map(Number);
      const items = m[2]!.toUpperCase();
      for (const uid of uids) {
        const index = this.server.messages.findIndex((x) => x.uid === uid);
        if (index < 0) continue;
        const msg = this.server.messages[index]!;
        const raw = Buffer.from(msg.raw, "latin1");
        const parts = [`UID ${uid}`];
        if (items.includes("RFC822.SIZE")) parts.push(`RFC822.SIZE ${raw.length}`);
        let body: Buffer | null = null;
        let section = "";
        if (items.includes("BODY.PEEK[HEADER]")) {
          const gap = msg.raw.indexOf("\r\n\r\n");
          body = Buffer.from(gap < 0 ? msg.raw : msg.raw.slice(0, gap + 4), "latin1");
          section = "BODY[HEADER]";
        } else if (items.includes("BODY.PEEK[]")) {
          body = raw;
          section = "BODY[]";
        }
        if (body) {
          this.send(`* ${index + 1} FETCH (${parts.join(" ")} ${section} {${body.length}}\r\n`);
          this.send(body);
          this.send(")\r\n");
        } else {
          this.send(`* ${index + 1} FETCH (${parts.join(" ")})\r\n`);
        }
      }
      return ok();
    }
    if (upper.startsWith("UID STORE ")) {
      const m = /^UID STORE ([\d,]+) \+FLAGS\.SILENT \(\\SEEN\)$/i.exec(rest);
      if (!m) return this.send(`${tag} BAD store\r\n`);
      for (const uid of m[1]!.split(",").map(Number)) {
        const msg = this.server.messages.find((x) => x.uid === uid);
        if (msg) msg.seen = true;
      }
      return ok();
    }
    if (upper === "IDLE") {
      if (!this.server.capabilities.includes("IDLE")) return this.send(`${tag} BAD no IDLE\r\n`);
      this.idleTag = tag;
      return this.send("+ idling\r\n");
    }
    if (upper === "LOGOUT") {
      this.send("* BYE logging out\r\n");
      this.send(`${tag} OK LOGOUT completed\r\n`);
      setImmediate(() => setImmediate(() => this.close()));
      return;
    }
    this.send(`${tag} BAD unknown command\r\n`);
  }

  private finishXoauth2(tag: string, blob: string): void {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    const expected = `user=${this.server.user}\u0001auth=Bearer ${this.server.token}\u0001\u0001`;
    if (decoded === expected) {
      this.loggedIn = true;
      this.send(`${tag} OK Success\r\n`);
      return;
    }
    // Like Gmail: a JSON challenge, then NO once the client answers with an empty line.
    this.saslFailTag = tag;
    this.send(`+ ${Buffer.from('{"status":"401"}').toString("base64")}\r\n`);
  }
}

/** Quoted strings or atoms, as LOGIN sends them. */
function parseAstrings(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!);
  }
  return out;
}
