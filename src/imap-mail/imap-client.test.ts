import { describe, expect, it } from "vitest";

import { FakeImapServer } from "./fake-imap-server-test-helpers.js";
import { ImapClient, ImapCommandError, type ImapTransport } from "./imap-client.js";

const MAIL = [
  "From: Boss <boss@example.com>",
  "Subject: hello",
  "",
  "body line",
  "",
].join("\r\n");

async function loggedIn(server: FakeImapServer): Promise<ImapClient> {
  const client = new ImapClient(server.connect(), { commandTimeoutMs: 2_000 });
  await client.ready();
  await client.login(server.user, server.password);
  return client;
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ImapClient (ATO-601)", () => {
  it("logs in, selects, searches, fetches and marks seen through split chunks", async () => {
    const server = new FakeImapServer({ chunkSize: 3 });
    server.deliver(MAIL, true);
    const uid = server.deliver(MAIL);
    const client = await loggedIn(server);
    expect(client.has("IDLE")).toBe(true);
    const box = await client.select("INBOX");
    expect(box).toEqual({ uidValidity: 42, uidNext: 3, exists: 2 });
    expect(await client.uidSearch("UNSEEN UID 1:*")).toEqual([uid]);
    const fetched = await client.uidFetch([uid], "(UID RFC822.SIZE BODY.PEEK[])");
    const item = fetched.get(uid)!;
    expect(item.size).toBe(Buffer.byteLength(MAIL));
    expect(item.body!.toString("latin1")).toBe(MAIL);
    await client.markSeen([uid]);
    expect(server.messages.every((m) => m.seen)).toBe(true);
    await client.logout();
    expect(client.isClosed).toBe(true);
    expect(server.commands).toContain("UID STORE 2 +FLAGS.SILENT (\\Seen)");
  });

  it("sends a non-ASCII password as a literal, never quoted", async () => {
    const server = new FakeImapServer({ password: "pässwörd" });
    const client = await loggedIn(server);
    await client.logout();
    expect(server.commands.some((c) => c.includes("pässwörd") && c.startsWith("LOGIN"))).toBe(true);
  });

  it("rejects wrong credentials with the server's answer", async () => {
    const server = new FakeImapServer();
    const client = new ImapClient(server.connect(), { commandTimeoutMs: 2_000 });
    await client.ready();
    await expect(client.login(server.user, "wrong")).rejects.toBeInstanceOf(ImapCommandError);
    await expect(client.select("INBOX")).rejects.toThrow(/before login/);
    client.close();
  });

  it("authenticates with XOAUTH2 inline (SASL-IR) and through a continuation", async () => {
    for (const caps of [["IMAP4rev1", "IDLE", "SASL-IR"], ["IMAP4rev1", "IDLE"]]) {
      const server = new FakeImapServer({ capabilities: caps });
      const client = new ImapClient(server.connect(), { commandTimeoutMs: 2_000 });
      await client.ready();
      await client.authenticateXoauth2(server.user, server.token);
      await client.select("INBOX");
      await client.logout();
    }
  });

  it("ends a failed XOAUTH2 exchange with an empty line and rejects", async () => {
    const server = new FakeImapServer();
    const client = new ImapClient(server.connect(), { commandTimeoutMs: 2_000 });
    await client.ready();
    await expect(client.authenticateXoauth2(server.user, "expired")).rejects.toBeInstanceOf(ImapCommandError);
    client.close();
  });

  it("IDLE returns on new mail and sends DONE", async () => {
    const server = new FakeImapServer();
    const client = await loggedIn(server);
    await client.select("INBOX");
    const waiting = client.idle(5_000);
    await until(() => server.commands.includes("IDLE"));
    await new Promise((r) => setTimeout(r, 20));
    server.deliver(MAIL);
    await expect(waiting).resolves.toBe("new-mail");
    expect(server.commands.at(-1)).toBe("DONE");
    // The connection is usable again after DONE.
    expect(await client.uidSearch("UNSEEN UID 1:*")).toEqual([1]);
    await client.logout();
  });

  it("IDLE ends on its timeout and on abort", async () => {
    const server = new FakeImapServer();
    const client = await loggedIn(server);
    await client.select("INBOX");
    await expect(client.idle(30)).resolves.toBe("timeout");
    const controller = new AbortController();
    const waiting = client.idle(5_000, controller.signal);
    await until(() => server.commands.filter((c) => c === "IDLE").length === 2);
    controller.abort();
    await expect(waiting).resolves.toBe("aborted");
    expect(server.commands.filter((c) => c === "DONE")).toHaveLength(2);
    await client.logout();
  });

  it("refuses IDLE when the server lacks it", async () => {
    const server = new FakeImapServer({ capabilities: ["IMAP4rev1"] });
    const client = await loggedIn(server);
    await expect(client.idle(10)).rejects.toThrow(/IDLE/);
    client.close();
  });

  it("fails the command in flight when the line drops", async () => {
    const server = new FakeImapServer();
    const client = await loggedIn(server);
    await client.select("INBOX");
    const waiting = client.idle(5_000);
    await until(() => server.commands.includes("IDLE"));
    server.open[0]!.kill();
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(client.uidSearch("ALL")).rejects.toThrow(/closed/);
  });

  it("rejects a BYE greeting and times out a silent server", async () => {
    let dataListener: ((b: Buffer) => void) | null = null;
    const bye: ImapTransport = {
      write: () => undefined,
      onData: (l) => {
        dataListener = l;
      },
      onClose: () => undefined,
      close: () => undefined,
    };
    const client = new ImapClient(bye);
    setImmediate(() => dataListener?.(Buffer.from("* BYE too many connections\r\n")));
    await expect(client.ready(1_000)).rejects.toThrow(/BYE|refused/);

    const silent = new ImapClient({ write: () => undefined, onData: () => undefined, onClose: () => undefined, close: () => undefined });
    await expect(silent.ready(20)).rejects.toThrow(/timed out/);
  });
});
