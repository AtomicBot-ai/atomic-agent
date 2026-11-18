/**
 * The real WhatsApp Web connector, on top of `baileys`
 * (WhiskeySockets/Baileys, MIT) (ATO-502).
 *
 * Everything baileys-specific lives in this one file, and baileys is
 * only loaded by `loadBaileysConnector()` with a dynamic import when the
 * channel actually starts. A user who never enables WhatsApp never loads
 * it, and a build that does not ship it (the single-file binary, where
 * the package is marked external in `scripts/bundle-sea.ts`) fails that
 * import, which the channel reports as `disabled` with a clear reason.
 *
 * The module is typed through the small structural interfaces below
 * rather than baileys' own types, so a type change in a baileys release
 * candidate does not break the build of everything else; the runtime
 * calls are the stable, documented ones (`makeWASocket`,
 * `useMultiFileAuthState`, `connection.update`, `messages.upsert`,
 * `sendMessage`, `sendPresenceUpdate`, `end`).
 */

import type { WhatsAppConnector, WhatsAppSocket, WhatsAppSocketEvents } from "./whatsapp-transport.js";
import type { RawWhatsAppMessage } from "./whatsapp-types.js";

interface BaileysAuthState {
  state: { creds: unknown; keys: unknown };
  saveCreds: () => Promise<void>;
}

interface BaileysConnectionUpdate {
  connection?: "connecting" | "open" | "close";
  qr?: string;
  lastDisconnect?: {
    error?: (Error & { output?: { statusCode?: number } }) | undefined;
  };
}

interface BaileysSocket {
  ev: {
    on(event: "creds.update", listener: () => void): void;
    on(event: "connection.update", listener: (update: BaileysConnectionUpdate) => void): void;
    on(
      event: "messages.upsert",
      listener: (upsert: { messages: unknown[]; type: string }) => void,
    ): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void>;
  end(error: Error | undefined): void;
}

interface BaileysModule {
  makeWASocket?: (config: Record<string, unknown>) => BaileysSocket;
  default?: ((config: Record<string, unknown>) => BaileysSocket) | { default?: unknown };
  useMultiFileAuthState: (folder: string) => Promise<BaileysAuthState>;
  makeCacheableSignalKeyStore?: (keys: unknown, logger: unknown) => unknown;
  fetchLatestWaWebVersion?: (options: Record<string, unknown>) => Promise<{ version: number[] }>;
  Browsers?: { macOS?: (browser: string) => unknown };
}

interface QrTerminalModule {
  generate(text: string, options: { small: boolean }, callback: (output: string) => void): void;
}

/** baileys wants a pino-shaped logger; ours stays silent (its debug output carries numbers). */
function silentLogger(): Record<string, unknown> {
  const noop = (): void => {};
  const logger: Record<string, unknown> = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger;
}

/** Load baileys and wrap it. Rejects when the module is missing or broken. */
export async function loadBaileysConnector(): Promise<WhatsAppConnector> {
  const mod = (await import("baileys")) as unknown as BaileysModule;
  const makeSocket =
    mod.makeWASocket ?? (typeof mod.default === "function" ? mod.default : undefined);
  if (typeof makeSocket !== "function" || typeof mod.useMultiFileAuthState !== "function") {
    throw new Error("baileys loaded but does not export makeWASocket/useMultiFileAuthState");
  }

  return {
    async connect({ authDir, events }): Promise<WhatsAppSocket> {
      const logger = silentLogger();
      const { state, saveCreds } = await mod.useMultiFileAuthState(authDir);
      // The WhatsApp Web version baked into a baileys release goes stale and
      // WhatsApp then refuses the connection; ask for the current one, and
      // fall back to the baked-in version when that lookup fails.
      let version: number[] | undefined;
      try {
        version = (await mod.fetchLatestWaWebVersion?.({}))?.version;
      } catch {
        version = undefined;
      }
      const keys = mod.makeCacheableSignalKeyStore
        ? mod.makeCacheableSignalKeyStore(state.keys, logger)
        : state.keys;
      const sock = makeSocket({
        auth: { creds: state.creds, keys },
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        ...(version ? { version } : {}),
        ...(mod.Browsers?.macOS ? { browser: mod.Browsers.macOS("Desktop") } : {}),
      });
      wire(sock, events, saveCreds);
      let closed = false;
      return {
        async sendText(jid, text) {
          await sock.sendMessage(jid, { text });
        },
        async sendTyping(jid, on) {
          await sock.sendPresenceUpdate(on ? "composing" : "paused", jid);
        },
        close() {
          if (closed) return;
          closed = true;
          // `end`, not `logout`: the device stays linked for the next start.
          sock.end(undefined);
        },
      };
    },

    async renderQr(qr) {
      const loaded = (await import("qrcode-terminal")) as unknown as
        | QrTerminalModule
        | { default: QrTerminalModule };
      const qrcode = "default" in loaded ? loaded.default : loaded;
      return await new Promise<string>((resolve) => {
        qrcode.generate(qr, { small: true }, (output) => resolve(output));
      });
    },
  };
}

function wire(sock: BaileysSocket, events: WhatsAppSocketEvents, saveCreds: () => Promise<void>): void {
  sock.ev.on("creds.update", () => {
    void saveCreds().catch(() => {
      // A failed write is retried on the next creds.update.
    });
  });
  sock.ev.on("connection.update", (update) => {
    if (typeof update.qr === "string" && update.qr.length > 0) events.onQr(update.qr);
    if (update.connection === "open") events.onOpen();
    if (update.connection === "close") {
      const err = update.lastDisconnect?.error;
      const statusCode = err?.output?.statusCode;
      events.onClose({
        statusCode: typeof statusCode === "number" ? statusCode : null,
        reason: err?.message ?? "connection closed",
      });
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // "append" is history sync and our own sends; only "notify" is new mail.
    if (type !== "notify") return;
    for (const message of messages) events.onMessage(message as RawWhatsAppMessage);
  });
}
