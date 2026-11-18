import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIL_TRIGGER_SOURCE } from "../atomic-mail/atomic-mail-trigger-message.js";
import { MAX_TASKS_PER_POLL } from "../atomic-mail/atomic-mail-trigger.js";
import type { WebhookConfig } from "../config/index.js";
import { IMAP_ATTACHMENT_DEFAULTS, type ImapTriggerConfig } from "../config/imap-trigger-config.js";
import { FakeImapServer } from "./fake-imap-server-test-helpers.js";
import { ImapMailTrigger, activeImapBindings, imapAutoStartSenders } from "./imap-mail-trigger.js";
import { IMAP_TRIGGER_STATE_FILENAME } from "./imap-trigger-state.js";

const PASS =
  "mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

function rawMail(
  over: {
    from?: string;
    /** The whole From value, instead of `Boss <from>`. */
    fromHeader?: string;
    subject?: string;
    auth?: string | null;
    body?: string;
    files?: Array<{ name: string; type: string; data: string }>;
  } = {},
): string {
  const head = [
    ...(over.auth === null ? [] : [`Authentication-Results: ${over.auth ?? PASS}`]),
    `From: ${over.fromHeader ?? `Boss <${over.from ?? "boss@example.com"}>`}`,
    `Subject: ${over.subject ?? "do the thing"}`,
    "Date: Wed, 18 Nov 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
  ];
  const body = over.body ?? "Please do the thing.";
  if (!over.files?.length) return [...head, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
  const parts = over.files.flatMap((f) => [
    "--b",
    `Content-Type: ${f.type}; name="${f.name}"`,
    `Content-Disposition: attachment; filename="${f.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(f.data, "latin1").toString("base64"),
  ]);
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    body,
    ...parts,
    "--b--",
    "",
  ].join("\r\n");
}

function binding(
  over: { email?: Partial<NonNullable<WebhookConfig["email"]>>; imap?: Partial<ImapTriggerConfig> } = {},
): WebhookConfig {
  return {
    source: "imap",
    userMessageTemplate: "Mail task from {{body.from}}",
    sessionMode: "ephemeral",
    email: {
      allowedSenders: ["boss@example.com"],
      pollIntervalMs: 60_000,
      replyByEmail: false,
      trustFromHeader: false,
      ...over.email,
    },
    imap: {
      host: "imap.gmail.com",
      port: 993,
      user: "me@example.com",
      auth: "login",
      password: "app-password",
      mailbox: "INBOX",
      idle: false,
      markSeen: true,
      authservId: "mx.google.com",
      attachments: IMAP_ATTACHMENT_DEFAULTS,
      ...over.imap,
    },
  };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ImapMailTrigger (ATO-601)", () => {
  let stateDir: string;
  let server: FakeImapServer;
  let bindings: Record<string, WebhookConfig>;
  let created: Array<{ binding: string; userMessage: string; sessionId: string | null; startPaused: boolean }>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  let trigger: ImapMailTrigger;
  let t: number;

  const make = (extra: Partial<ConstructorParameters<typeof ImapMailTrigger>[0]> = {}) =>
    new ImapMailTrigger({
      stateDir,
      bindings: () => bindings,
      createTask: (input) => {
        created.push(input);
        return { id: `task-${created.length}` };
      },
      resolveSessionId: () => null,
      connect: async () => server.connect(),
      logger,
      env: {},
      ...extra,
    });

  /** Ticks far enough apart that every binding is due. */
  const tick = async () => {
    t += 61_000;
    await trigger.tick(t);
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "imap-trigger-"));
    server = new FakeImapServer({ chunkSize: 64 });
    bindings = { gmail: binding() };
    created = [];
    logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    trigger = make();
    t = Date.now();
  });

  afterEach(async () => {
    await trigger.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("primes on first contact, then turns a new mail into a fenced task and marks it read", async () => {
    server.deliver(rawMail({ subject: "old" }));
    await tick();
    expect(created).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(stateDir, IMAP_TRIGGER_STATE_FILENAME), "utf8"));
    expect(state.bindings.gmail).toMatchObject({ uidValidity: 42, lastUid: 1 });
    expect(statSync(join(stateDir, IMAP_TRIGGER_STATE_FILENAME)).mode & 0o777).toBe(0o600);

    const uid = server.deliver(rawMail({ subject: "new one" }));
    await tick();
    expect(created).toHaveLength(1);
    const msg = created[0]!.userMessage;
    expect(msg.startsWith("Mail task from boss@example.com")).toBe(true);
    expect(msg).toContain(MAIL_TRIGGER_SOURCE);
    expect(msg).toContain("Subject: new one");
    expect(msg).toContain("Please do the thing.");
    expect(server.messages.find((m) => m.uid === uid)!.seen).toBe(true);
    expect(server.messages[0]!.seen).toBe(false);
    // Every connection was closed after its poll.
    await until(() => server.open.length === 0);

    await tick();
    expect(created).toHaveLength(1);
  });

  it("starts only the mailbox owner's own mail at once; other allowed senders wait paused", async () => {
    await tick();
    server.deliver(rawMail({ subject: "from boss" }));
    // The mailbox's own address is allowed even when it is not listed.
    server.deliver(rawMail({ from: "me@example.com", subject: "from me" }));
    await tick();
    expect(created.map((c) => [/Subject: (.*)/.exec(c.userMessage)?.[1], c.startPaused])).toEqual([
      ["from boss", true],
      ["from me", false],
    ]);
    expect(logger.info).toHaveBeenCalledWith("mail trigger: task created, waiting to be started", expect.anything());

    bindings = {
      gmail: binding({ email: { allowedSenders: ["boss@example.com", "me@example.com"], autoStartSenders: ["boss@example.com"] } }),
    };
    server.deliver(rawMail({ subject: "boss again" }));
    server.deliver(rawMail({ from: "me@example.com", subject: "me again" }));
    await tick();
    expect(created.slice(2).map((c) => c.startPaused)).toEqual([false, true]);
  });

  it("picks the auto-start default from the login name", () => {
    expect(imapAutoStartSenders(binding() as never)).toEqual(["me@example.com"]);
    expect(imapAutoStartSenders(binding({ imap: { user: "me" } }) as never)).toEqual([]);
    expect(imapAutoStartSenders(binding({ email: { autoStartSenders: [] } }) as never)).toEqual([]);
  });

  it("never downloads, marks or acts on mail from a sender off the list", async () => {
    await tick();
    server.deliver(rawMail({ from: "stranger@else.org", auth: PASS.replace(/example\.com/g, "else.org") }));
    await tick();
    expect(created).toHaveLength(0);
    expect(server.commands.some((c) => c.includes("BODY.PEEK[]"))).toBe(false);
    expect(server.messages[0]!.seen).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("mail trigger: message ignored", expect.objectContaining({ reason: "sender not in allowedSenders" }));
    const headerFetches = server.commands.filter((c) => c.includes("BODY.PEEK[HEADER]")).length;
    await tick();
    expect(server.commands.filter((c) => c.includes("BODY.PEEK[HEADER]")).length).toBe(headerFetches);
  });

  it("refuses a forged topmost header and mail with no authentication, unless trustFromHeader", async () => {
    await tick();
    server.deliver(rawMail({ auth: "evil.example; dmarc=pass header.from=example.com" }));
    server.deliver(rawMail({ auth: null }));
    server.deliver(rawMail({ auth: "mx.google.com; dmarc=fail header.from=example.com" }));
    await tick();
    expect(created).toHaveLength(0);
    const reasons = logger.info.mock.calls.filter((c) => c[0] === "mail trigger: message ignored").map((c) => c[1].reason);
    expect(reasons[0]).toMatch(/not from mx\.google\.com/);
    expect(reasons[1]).toMatch(/not from mx\.google\.com/);
    expect(reasons[2]).toMatch(/DMARC/);

    bindings = { gmail: binding({ email: { trustFromHeader: true } }) };
    server.deliver(rawMail({ auth: null }));
    await tick();
    expect(created).toHaveLength(1);
  });

  it("without an authserv-id, judges the topmost header alone", async () => {
    bindings = { gmail: binding({ imap: { authservId: undefined } }) };
    await tick();
    server.deliver(rawMail({ auth: "mx.fastmail.com; dkim=pass header.d=example.com" }));
    await tick();
    expect(created).toHaveLength(1);
  });

  it("without an authserv-id, never auto-starts, even the owner's own mail", async () => {
    bindings = { gmail: binding({ imap: { authservId: undefined } }) };
    await tick();
    server.deliver(rawMail({ from: "me@example.com", subject: "own, no authserv-id" }));
    await tick();
    expect(created.map((c) => c.startPaused)).toEqual([true]);
  });

  it("does not take the owner's address from a quoted display name", async () => {
    bindings = { gmail: binding({ email: { allowedSenders: ["@example.com"] } }) };
    await tick();
    server.deliver(rawMail({ fromHeader: '"<me@example.com>" <coworker@example.com>', subject: "spoof" }));
    server.deliver(rawMail({ fromHeader: "coworker@example.com, me@example.com", subject: "two" }));
    await tick();
    expect(created.map((c) => [/Subject: (.*)/.exec(c.userMessage)?.[1], c.startPaused])).toEqual([["spoof", true]]);
  });

  it("saves allowed attachments and lists their paths; blocked ones are named, not saved", async () => {
    await tick();
    server.deliver(
      rawMail({
        files: [
          { name: "report.pdf", type: "application/pdf", data: "%PDF-1.4 x" },
          { name: "setup.exe", type: "application/octet-stream", data: "MZ\u0090" },
        ],
      }),
    );
    await tick();
    expect(created).toHaveLength(1);
    const msg = created[0]!.userMessage;
    expect(msg).toContain("[attachments]");
    const path = /- (\/\S+report\.pdf) /.exec(msg)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(join(stateDir, "inbox", "email", "gmail"))).toBe(true);
    expect(readFileSync(path!, "latin1")).toBe("%PDF-1.4 x");
    expect(msg).toMatch(/setup\.exe: not saved \(blocked/);
    expect(msg).toContain("os.fs.read");
  });

  it(`creates at most ${MAX_TASKS_PER_POLL} tasks per pass; the rest come next time`, async () => {
    await tick();
    for (let i = 0; i < MAX_TASKS_PER_POLL + 2; i += 1) server.deliver(rawMail({ subject: `m${i}` }));
    await tick();
    expect(created).toHaveLength(MAX_TASKS_PER_POLL);
    await tick();
    expect(created).toHaveLength(MAX_TASKS_PER_POLL + 2);
    expect(created.map((c) => /Subject: (m\d+)/.exec(c.userMessage)?.[1])).toEqual(
      Array.from({ length: MAX_TASKS_PER_POLL + 2 }, (_, i) => `m${i}`),
    );
  });

  it("skips mail that is already read, and leaves mail unread when markSeen is off", async () => {
    bindings = { gmail: binding({ imap: { markSeen: false } }) };
    await tick();
    server.deliver(rawMail({ subject: "read on the phone" }), true);
    server.deliver(rawMail({ subject: "fresh" }));
    await tick();
    expect(created).toHaveLength(1);
    expect(created[0]!.userMessage).toContain("Subject: fresh");
    expect(server.messages[1]!.seen).toBe(false);
  });

  it("primes again when UIDVALIDITY changes, without replaying the folder", async () => {
    await tick();
    server.deliver(rawMail());
    server.uidValidity = 99;
    await tick();
    expect(created).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "imap trigger primed; mail already in the folder is skipped",
      expect.objectContaining({ reason: "UIDVALIDITY changed" }),
    );
  });

  it("primes from UID SEARCH ALL when the server sends no UIDNEXT", async () => {
    server = new FakeImapServer({ omitUidNext: true });
    server.deliver(rawMail());
    server.deliver(rawMail());
    await tick();
    const state = JSON.parse(readFileSync(join(stateDir, IMAP_TRIGGER_STATE_FILENAME), "utf8"));
    expect(state.bindings.gmail.lastUid).toBe(2);
  });

  it("does not connect without a password, and logs why", async () => {
    bindings = { gmail: binding({ imap: { password: undefined, passwordEnv: "GMAIL_APP_PASSWORD" } }) };
    await tick();
    expect(server.connections).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "imap trigger: poll failed",
      expect.objectContaining({ error: expect.stringMatching(/GMAIL_APP_PASSWORD is not set/) }),
    );
    trigger = make({ env: { GMAIL_APP_PASSWORD: "app-password" } });
    await tick();
    expect(server.connections).toHaveLength(1);
  });

  it("logs in with XOAUTH2 when asked", async () => {
    bindings = { gmail: binding({ imap: { auth: "xoauth2", password: server.token } }) };
    await tick();
    expect(server.commands.some((c) => c.startsWith("AUTHENTICATE XOAUTH2"))).toBe(true);
    expect(existsSync(join(stateDir, IMAP_TRIGGER_STATE_FILENAME))).toBe(true);
  });

  it("stays off for an empty allow-list or another source", () => {
    expect(activeImapBindings({ a: binding({ email: { allowedSenders: [] } }) })).toEqual([]);
    expect(activeImapBindings({ a: { ...binding(), source: "atomic-mail" } })).toEqual([]);
    expect(activeImapBindings({ a: binding() }).map(([n]) => n)).toEqual(["a"]);
  });

  describe("IDLE (push)", () => {
    beforeEach(() => {
      bindings = { gmail: binding({ imap: { idle: true } }) };
      t = Date.now();
    });

    it("keeps one connection waiting and creates the task as the mail arrives, with no further tick", async () => {
      await trigger.tick(t);
      await until(() => server.commands.includes("IDLE"));
      expect(server.open).toHaveLength(1);
      server.deliver(rawMail({ subject: "pushed" }));
      await until(() => created.length === 1);
      expect(created[0]!.userMessage).toContain("Subject: pushed");
      // Back to waiting on the same connection.
      await until(() => server.commands.filter((c) => c === "IDLE").length === 2);
      expect(server.connections).toHaveLength(1);
      // A tick while IDLE runs does not open a polling connection beside it.
      await trigger.tick(t + 61_000);
      expect(server.connections).toHaveLength(1);
      await trigger.stop();
      await until(() => server.open.length === 0);
    });

    it("falls back to polling when the server has no IDLE", async () => {
      server = new FakeImapServer({ capabilities: ["IMAP4rev1"] });
      await trigger.tick(t);
      await until(() => logger.info.mock.calls.some((c) => c[0] === "imap trigger: server has no IDLE; polling instead"));
      await until(() => server.open.length === 0);
      await trigger.tick(Date.now() + 61_000);
      server.deliver(rawMail());
      await trigger.tick(Date.now() + 122_000);
      expect(created).toHaveLength(1);
    });

    it("closes the connection when the scheduler stops", async () => {
      const controller = new AbortController();
      await trigger.tick(t, controller.signal);
      await until(() => server.commands.includes("IDLE"));
      controller.abort();
      await until(() => server.open.length === 0);
    });

    it("lets go of the connection once ticks stop coming (another process leads)", async () => {
      let now = t;
      trigger = make({ clock: () => now, idleCycleMs: 20 });
      await trigger.tick(now);
      await until(() => server.commands.includes("IDLE"));
      now += 11 * 60 * 1000;
      await until(() => server.open.length === 0);
      server.deliver(rawMail());
      await new Promise((r) => setTimeout(r, 50));
      expect(created).toHaveLength(0);
    });

    it("recovers after the IDLE connection drops: the mail that came meanwhile is not lost", async () => {
      await trigger.tick(t);
      await until(() => server.commands.includes("IDLE"));
      server.open[0]!.kill();
      await until(() => logger.warn.mock.calls.some((c) => c[0] === "imap trigger: IDLE connection failed; polling until it is retried"));
      server.deliver(rawMail({ subject: "while down" }));
      // Too soon for a poll or an IDLE retry.
      await trigger.tick(Date.now() + 1_000);
      expect(created).toHaveLength(0);
      // Due again: either the poll or the retried IDLE picks it up.
      await trigger.tick(Date.now() + 61_000);
      await until(() => created.length === 1);
      expect(created[0]!.userMessage).toContain("Subject: while down");
    });
  });
});
