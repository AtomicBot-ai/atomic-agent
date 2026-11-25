import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import {
  IMAP_ATTACHMENT_DEFAULTS,
  parseImapTriggerConfig,
  resolveImapSecret,
} from "./imap-trigger-config.js";
import { parseWebhookMap } from "./webhook-config.js";

describe("parseImapTriggerConfig (ATO-601)", () => {
  it("fills the defaults and the Gmail authserv-id", () => {
    expect(
      parseImapTriggerConfig({ host: "IMAP.gmail.com", user: "me@gmail.com", passwordEnv: "GMAIL_APP_PASSWORD" }, "f"),
    ).toEqual({
      host: "imap.gmail.com",
      port: 993,
      user: "me@gmail.com",
      auth: "login",
      passwordEnv: "GMAIL_APP_PASSWORD",
      mailbox: "INBOX",
      idle: true,
      markSeen: true,
      authservId: "mx.google.com",
      attachments: IMAP_ATTACHMENT_DEFAULTS,
    });
  });

  it("reads every field", () => {
    const cfg = parseImapTriggerConfig(
      {
        host: "imap.fastmail.com",
        port: 1993,
        user: "me",
        auth: "xoauth2",
        password: "token",
        mailbox: "Agent",
        idle: false,
        markSeen: false,
        authservId: "Mx.Fastmail.com",
        attachments: { save: false, maxCount: 3, maxBytes: 1000, maxTotalBytes: 2000 },
      },
      "f",
    );
    expect(cfg).toMatchObject({
      port: 1993,
      auth: "xoauth2",
      password: "token",
      mailbox: "Agent",
      idle: false,
      markSeen: false,
      authservId: "mx.fastmail.com",
      attachments: { save: false, maxCount: 3, maxBytes: 1000, maxTotalBytes: 2000 },
    });
  });

  it.each([
    [undefined],
    [{ user: "me", password: "p" }],
    [{ host: "imap.x.com", password: "p" }],
    [{ host: "imap.x.com", user: "me" }],
    [{ host: "imap x.com", user: "me", password: "p" }],
    [{ host: "imap.x.com", user: "me", password: "p", tls: false }],
    [{ host: "imap.x.com", user: "me", password: "p", starttls: true }],
    [{ host: "imap.x.com", user: "me", password: "p", auth: "plain" }],
    [{ host: "imap.x.com", user: "me", passwordEnv: "not a name" }],
    [{ host: "imap.x.com", user: "me", password: "a\r\nb" }],
    [{ host: "imap.x.com", user: "me", password: "p", mailbox: "Входящие" }],
    [{ host: "imap.x.com", user: "me", password: "p", port: 0 }],
    [{ host: "imap.x.com", user: "me", password: "p", attachments: { maxTotalBytes: 10 ** 9 } }],
  ])("refuses %j", (raw) => {
    expect(() => parseImapTriggerConfig(raw, "f")).toThrow(ConfigValidationError);
  });

  it("reads the secret from the variable first, then inline", () => {
    expect(resolveImapSecret({ passwordEnv: "P", password: "inline" }, { P: "from-env" })).toBe("from-env");
    expect(resolveImapSecret({ passwordEnv: "P", password: "inline" }, {})).toBe("inline");
    expect(resolveImapSecret({ passwordEnv: "P" }, {})).toBeNull();
  });
});

describe("webhooks with source imap (ATO-601)", () => {
  const imap = { host: "imap.gmail.com", user: "me@gmail.com", passwordEnv: "GMAIL_APP_PASSWORD" };

  it("parses an imap binding with its email block", () => {
    const map = parseWebhookMap(
      { gmail: { source: "imap", userMessageTemplate: "Mail from {{body.from}}", email: { allowedSenders: ["me@gmail.com"] }, imap } },
      "webhooks",
    );
    expect(map.gmail).toMatchObject({ source: "imap", email: { allowedSenders: ["me@gmail.com"] }, imap: { host: "imap.gmail.com" } });
  });

  it.each([
    [{ source: "imap", userMessageTemplate: "t", imap }],
    [{ source: "imap", userMessageTemplate: "t", email: { allowedSenders: [] } }],
    [{ source: "imap", userMessageTemplate: "t", email: { allowedSenders: [], replyByEmail: true }, imap }],
    [{ source: "imap", userMessageTemplate: "t", email: { allowedSenders: [] }, imap, schedule: { kind: "interval", everyMs: 60000 } }],
    [{ source: "atomic-mail", userMessageTemplate: "t", email: { allowedSenders: [] }, imap }],
    [{ userMessageTemplate: "t", imap }],
    [{ source: "pop3", userMessageTemplate: "t" }],
  ])("refuses %j", (binding) => {
    expect(() => parseWebhookMap({ b: binding }, "webhooks")).toThrow(ConfigValidationError);
  });
});
