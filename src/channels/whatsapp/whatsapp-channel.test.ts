import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTRA_CHANNELS } from "../channel-catalog.js";
import type { ChannelContext } from "../channel.js";
import { WHATSAPP_CHANNEL } from "./index.js";
import { WhatsAppChannel } from "./whatsapp-channel.js";
import type { WhatsAppConnector, WhatsAppSocket, WhatsAppSocketEvents } from "./whatsapp-transport.js";
import { WHATSAPP_MODULE_MISSING, WHATSAPP_PAIR_AGAIN } from "./whatsapp-types.js";

const OWNER = "+1 555 000 2222";
const OWNER_JID = "15550002222@s.whatsapp.net";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeCtx(channelConfig: ChannelContext["channelConfig"], replyText = "done") {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-channel-"));
  dirs.push(dir);
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const runTurn = vi.fn(async (_s: unknown, _p: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: replyText } });
    return {};
  });
  const ctx = {
    runtime: {
      runTurn,
      sessionStore: { load: () => null },
      createSession: () => ({ id: "s-1", metadata: {} }),
    } as never,
    config: {} as never,
    channelConfig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    stateDir: dir,
    inboxDir: join(dir, "inbox", "whatsapp"),
    emitStatus: (s: { state: string; lastError?: string }) => statuses.push(s),
  } as ChannelContext;
  return { ctx, statuses, dir, runTurn };
}

const on = (options: Record<string, string | number | boolean> = {}) => ({
  enabled: true,
  ownerIds: [OWNER],
  options,
});

/** A fake WhatsApp Web connector: the test drives the socket events. */
function fakeConnector() {
  const sockets: Array<{ events: WhatsAppSocketEvents; sent: Array<{ jid: string; text: string }>; closed: boolean }> = [];
  const connector: WhatsAppConnector = {
    connect: vi.fn(async ({ events }: { authDir: string; events: WhatsAppSocketEvents }) => {
      const entry = { events, sent: [] as Array<{ jid: string; text: string }>, closed: false };
      sockets.push(entry);
      const socket: WhatsAppSocket = {
        sendText: async (jid, text) => {
          entry.sent.push({ jid, text });
        },
        close: () => {
          entry.closed = true;
        },
      };
      return socket;
    }),
    renderQr: async (qr) => `[QR ${qr}]`,
  };
  return { connector, sockets, load: async () => connector };
}

const lock = () => ({ acquire: vi.fn(), release: vi.fn() });

describe("WhatsAppChannel", () => {
  it("is in the channel catalog and builds without side effects", () => {
    expect(EXTRA_CHANNELS.map((d) => d.id)).toContain("whatsapp");
    const { ctx, dir } = makeCtx(on());
    const channel = WHATSAPP_CHANNEL.create(ctx);
    expect(WHATSAPP_CHANNEL.label).toBe("WhatsApp");
    expect(channel.id).toBe("whatsapp");
    expect(channel.state()).toBe("disabled");
    expect(existsSync(join(dir, "whatsapp-auth"))).toBe(false);
  });

  it("stays disabled and never loads the library when switched off", async () => {
    const load = vi.fn();
    const l = lock();
    const channel = new WhatsAppChannel(makeCtx({ ...on(), enabled: false }).ctx, { load, lock: l });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    expect(load).not.toHaveBeenCalled();
    expect(l.acquire).not.toHaveBeenCalled();
  });

  it("reports disabled with a clear reason when the library cannot be loaded", async () => {
    const l = lock();
    const { ctx, statuses } = makeCtx(on());
    const channel = new WhatsAppChannel(ctx, {
      lock: l,
      load: async () => {
        throw new Error("Cannot find package 'baileys'");
      },
    });
    await channel.start();
    expect(channel.state()).toBe("disabled");
    expect(channel.lastError()).toBe(WHATSAPP_MODULE_MISSING);
    expect(statuses.at(-1)).toEqual({ channel: "whatsapp", state: "disabled", lastError: WHATSAPP_MODULE_MISSING });
    expect(l.release).toHaveBeenCalledTimes(1);
  });

  it("writes the QR to a file and says where while waiting to be paired, then comes up", async () => {
    const fake = fakeConnector();
    const { ctx, dir } = makeCtx(on());
    const channel = new WhatsAppChannel(ctx, { load: fake.load, lock: lock() });
    await channel.start();
    expect(fake.connector.connect).toHaveBeenCalledWith(
      expect.objectContaining({ authDir: join(dir, "whatsapp-auth") }),
    );
    fake.sockets[0]?.events.onQr("ref-1");
    const qrPath = join(dir, "whatsapp-qr.txt");
    await vi.waitFor(() => expect(channel.state()).toBe("down"));
    expect(channel.lastError()).toContain(qrPath);
    const qrFile = readFileSync(qrPath, "utf8");
    expect(qrFile).toContain("[QR ref-1]");
    expect(qrFile).toMatch(/unofficial/);
    expect(qrFile).toMatch(/banned|ban/);

    fake.sockets[0]?.events.onOpen();
    expect(channel.state()).toBe("up");
    expect(channel.lastError()).toBeNull();
    expect(existsSync(qrPath)).toBe(false);
    await channel.stop();
  });

  it("reconnects at once after the post-pairing restart request", async () => {
    const fake = fakeConnector();
    const channel = new WhatsAppChannel(makeCtx(on()).ctx, { load: fake.load, lock: lock() });
    await channel.start();
    fake.sockets[0]?.events.onQr("ref-1");
    fake.sockets[0]?.events.onClose({ statusCode: 515, reason: "restart required" });
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
    fake.sockets[1]?.events.onOpen();
    expect(channel.state()).toBe("up");
    await channel.stop();
  });

  it("logged out: goes down with 'pair again', deletes the keys, does not reconnect", async () => {
    const fake = fakeConnector();
    const { ctx, dir, statuses } = makeCtx(on());
    const backoff = vi.fn(() => 0);
    const channel = new WhatsAppChannel(ctx, { load: fake.load, lock: lock(), backoff });
    await channel.start();
    const authDir = join(dir, "whatsapp-auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "creds.json"), "{}");
    fake.sockets[0]?.events.onOpen();
    fake.sockets[0]?.events.onClose({ statusCode: 401, reason: "Connection Failure" });
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toBe(WHATSAPP_PAIR_AGAIN);
    expect(statuses.at(-1)).toMatchObject({ state: "down", lastError: WHATSAPP_PAIR_AGAIN });
    expect(existsSync(authDir)).toBe(false);
    expect(backoff).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.sockets).toHaveLength(1);
    await channel.stop();
  });

  it("keeps the keys and retries with backoff on an ordinary drop", async () => {
    const fake = fakeConnector();
    const { ctx, dir } = makeCtx(on());
    const backoff = vi.fn(() => 0);
    const channel = new WhatsAppChannel(ctx, { load: fake.load, lock: lock(), backoff });
    await channel.start();
    const creds = join(dir, "whatsapp-auth", "creds.json");
    writeFileSync(creds, "{}");
    fake.sockets[0]?.events.onOpen();
    fake.sockets[0]?.events.onClose({ statusCode: 428, reason: "Connection Closed" });
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/connection lost \(428\)/);
    expect(backoff).toHaveBeenCalledWith(0);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(existsSync(creds)).toBe(true);
    fake.sockets[1]?.events.onOpen();
    expect(channel.state()).toBe("up");
    await channel.stop();
  });

  it("stops asking once an unscanned QR times out", async () => {
    const fake = fakeConnector();
    const backoff = vi.fn(() => 0);
    const channel = new WhatsAppChannel(makeCtx(on()).ctx, { load: fake.load, lock: lock(), backoff });
    await channel.start();
    fake.sockets[0]?.events.onQr("ref-1");
    fake.sockets[0]?.events.onClose({ statusCode: 408, reason: "QR refs attempts ended" });
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/not scanned in time/);
    expect(backoff).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("answers an owner DM through the socket and ignores events from a closed socket", async () => {
    const fake = fakeConnector();
    const { ctx, runTurn } = makeCtx(on());
    const channel = new WhatsAppChannel(ctx, { load: fake.load, lock: lock() });
    await channel.start();
    fake.sockets[0]?.events.onOpen();
    fake.sockets[0]?.events.onMessage({
      key: { remoteJid: OWNER_JID, fromMe: false, id: "M1" },
      message: { conversation: "hello" },
    });
    await vi.waitFor(() => expect(fake.sockets[0]?.sent).toEqual([{ jid: OWNER_JID, text: "done" }]));
    expect(runTurn.mock.calls[0]?.[2]).toMatchObject({ origin: "whatsapp" });

    await channel.stop();
    expect(fake.sockets[0]?.closed).toBe(true);
    expect(channel.state()).toBe("disabled");
    fake.sockets[0]?.events.onMessage({
      key: { remoteJid: OWNER_JID, fromMe: false, id: "M2" },
      message: { conversation: "after stop" },
    });
    fake.sockets[0]?.events.onClose({ statusCode: 428, reason: "closed" });
    expect(channel.state()).toBe("disabled");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("releases the lock once and stop is idempotent", async () => {
    const fake = fakeConnector();
    const l = lock();
    const channel = new WhatsAppChannel(makeCtx(on()).ctx, { load: fake.load, lock: l });
    await channel.start();
    expect(l.acquire).toHaveBeenCalledTimes(1);
    await channel.stop();
    await channel.stop();
    expect(l.release).toHaveBeenCalledTimes(1);
  });

  it("goes down when another process holds the lock", async () => {
    const fake = fakeConnector();
    const channel = new WhatsAppChannel(makeCtx(on()).ctx, {
      load: fake.load,
      lock: {
        acquire: () => {
          throw new Error("channel-locked: another atomic-agent process (pid 42) owns this channel");
        },
        release: vi.fn(),
      },
    });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(fake.connector.connect).not.toHaveBeenCalled();
  });
});
