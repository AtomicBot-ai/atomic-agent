import { describe, expect, it } from "vitest";

import {
  type RawWhatsAppContent,
  type RawWhatsAppMessage,
  WHATSAPP_PAIR_AGAIN,
  chatKeyOf,
  classifyClose,
  normalizeWhatsAppId,
  parseWhatsAppMessage,
  readWhatsAppOptions,
  scrubWhatsAppError,
} from "./whatsapp-types.js";

const OWNER_JID = "15550002222@s.whatsapp.net";

describe("normalizeWhatsAppId", () => {
  it("turns phone numbers typed by an operator into a user JID", () => {
    expect(normalizeWhatsAppId("+1 555 000-2222")).toBe(OWNER_JID);
    expect(normalizeWhatsAppId("15550002222")).toBe(OWNER_JID);
  });

  it("drops the device suffix and maps the legacy c.us server", () => {
    expect(normalizeWhatsAppId("15550002222:7@s.whatsapp.net")).toBe(OWNER_JID);
    expect(normalizeWhatsAppId("15550002222@c.us")).toBe(OWNER_JID);
    expect(normalizeWhatsAppId("98765@LID")).toBe("98765@lid");
    expect(normalizeWhatsAppId("12036300@g.us")).toBe("12036300@g.us");
  });
});

describe("parseWhatsAppMessage", () => {
  type Key = NonNullable<RawWhatsAppMessage["key"]>;
  const dm = (over: Key = {}, message: RawWhatsAppContent = { conversation: "hi" }): RawWhatsAppMessage => ({
    key: { remoteJid: OWNER_JID, fromMe: false, id: "M1", ...over },
    pushName: "Ada",
    message,
  });

  it("reads a plain DM", () => {
    const parsed = parseWhatsAppMessage(dm());
    expect(parsed).toEqual({
      kind: "message",
      message: {
        id: "M1",
        chatJid: OWNER_JID,
        senderIds: [OWNER_JID],
        senderName: "Ada",
        text: "hi",
        isGroup: false,
        hasMedia: false,
      },
    });
  });

  it("ignores our own messages, status updates, broadcasts and channels", () => {
    expect(parseWhatsAppMessage(dm({ fromMe: true }))).toEqual({ kind: "ignore", reason: "from-me" });
    expect(parseWhatsAppMessage(dm({ remoteJid: "status@broadcast" }))).toEqual({
      kind: "ignore",
      reason: "broadcast",
    });
    expect(parseWhatsAppMessage(dm({ remoteJid: "123@broadcast" })).kind).toBe("ignore");
    expect(parseWhatsAppMessage(dm({ remoteJid: "123@newsletter" })).kind).toBe("ignore");
    expect(parseWhatsAppMessage({ message: { conversation: "x" } })).toEqual({ kind: "ignore", reason: "no-key" });
    expect(parseWhatsAppMessage(dm({}, {}))).toEqual({ kind: "ignore", reason: "empty" });
  });

  it("takes the sender of a group message from participant, with the alternate id", () => {
    const parsed = parseWhatsAppMessage(
      dm({ remoteJid: "12036300@g.us", participant: "98765@lid", participantAlt: "15550002222:3@s.whatsapp.net" }),
    );
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.isGroup).toBe(true);
    expect(parsed.message.senderIds).toEqual(["98765@lid", OWNER_JID]);
    expect(chatKeyOf(parsed.message)).toBe("group:12036300@g.us");
  });

  it("knows a DM sender by its privacy id and its phone JID", () => {
    const parsed = parseWhatsAppMessage(dm({ remoteJid: "98765@lid", remoteJidAlt: OWNER_JID }));
    if (parsed.kind !== "message") throw new Error("expected a message");
    expect(parsed.message.senderIds).toEqual(["98765@lid", OWNER_JID]);
    expect(chatKeyOf(parsed.message)).toBe("dm:98765@lid");
  });

  it("unwraps disappearing messages and reads captions; flags media", () => {
    const wrapped = parseWhatsAppMessage(dm({}, { ephemeralMessage: { message: { extendedTextMessage: { text: "secret" } } } }));
    expect(wrapped.kind === "message" && wrapped.message.text).toBe("secret");
    const photo = parseWhatsAppMessage(dm({}, { imageMessage: { caption: "what is this" } }));
    expect(photo.kind === "message" && photo.message).toMatchObject({ text: "what is this", hasMedia: true });
    const voice = parseWhatsAppMessage(dm({}, { audioMessage: {} }));
    expect(voice.kind === "message" && voice.message).toMatchObject({ text: "", hasMedia: true });
  });
});

describe("classifyClose", () => {
  it("logged out: stop, clear the keys, tell the operator to pair again", () => {
    expect(classifyClose(401, "Connection Failure", false)).toEqual({
      action: "stop",
      clearAuth: true,
      message: WHATSAPP_PAIR_AGAIN,
    });
  });

  it("reconnects at once when WhatsApp asks for a restart after pairing", () => {
    expect(classifyClose(515, "Stream Errored (restart required)", true)).toMatchObject({
      action: "reconnect-now",
      clearAuth: false,
    });
  });

  it("stops when an unscanned QR times out instead of printing codes forever", () => {
    expect(classifyClose(408, "QR refs attempts ended", true)).toMatchObject({ action: "stop", clearAuth: false });
  });

  it("retries other drops with backoff and keeps the keys", () => {
    expect(classifyClose(408, "Connection was lost", false)).toMatchObject({
      action: "reconnect-later",
      clearAuth: false,
    });
    expect(classifyClose(null, "socket hang up", false).action).toBe("reconnect-later");
  });

  it("stops on a replaced session and on 403", () => {
    expect(classifyClose(440, "replaced", false)).toMatchObject({ action: "stop", clearAuth: false });
    expect(classifyClose(403, "forbidden", false)).toMatchObject({ action: "stop", clearAuth: false });
  });
});

describe("options and scrubbing", () => {
  it("allowGroups is off unless set", () => {
    expect(readWhatsAppOptions({ enabled: true, ownerIds: [], options: {} }).allowGroups).toBe(false);
    expect(readWhatsAppOptions({ enabled: true, ownerIds: [], options: { allowGroups: true } }).allowGroups).toBe(true);
  });

  it("removes phone numbers and key-like strings", () => {
    const out = scrubWhatsAppError(new Error(`failed for 15550002222@s.whatsapp.net key=${"a".repeat(50)}`));
    expect(out).not.toContain("15550002222");
    expect(out).not.toContain("aaaaaaaaaa");
  });
});
