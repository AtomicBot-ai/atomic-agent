import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import {
  EMAIL_TRIGGER_DEFAULT_POLL_MS,
  parseEmailTriggerConfig,
} from "./email-trigger-config.js";
import { parseWebhookMap } from "./webhook-config.js";

describe("parseEmailTriggerConfig (ATO-601)", () => {
  it("normalises senders and fills the defaults", () => {
    expect(
      parseEmailTriggerConfig(
        { allowedSenders: [" Boss@Example.com ", "@corp.io", "boss@example.com"] },
        "f",
      ),
    ).toEqual({
      allowedSenders: ["boss@example.com", "@corp.io"],
      pollIntervalMs: EMAIL_TRIGGER_DEFAULT_POLL_MS,
      replyByEmail: false,
    });
  });

  it("accepts an empty allow-list (trigger off)", () => {
    expect(parseEmailTriggerConfig({ allowedSenders: [] }, "f").allowedSenders).toEqual([]);
  });

  it.each([
    [undefined],
    [{}],
    [{ allowedSenders: "boss@example.com" }],
    [{ allowedSenders: ["not an address"] }],
    [{ allowedSenders: ["@nodot"] }],
    [{ allowedSenders: [42] }],
    [{ allowedSenders: [], pollIntervalMs: 1_000 }],
    [{ allowedSenders: [], pollIntervalMs: 45_000.5 }],
    [{ allowedSenders: [], replyByEmail: "yes" }],
  ])("rejects %j", (raw) => {
    expect(() => parseEmailTriggerConfig(raw, "f")).toThrow(ConfigValidationError);
  });
});

describe("parseWebhookMap with source atomic-mail", () => {
  it("keeps http bindings unchanged (no source/email keys)", () => {
    const out = parseWebhookMap({ ping: { userMessageTemplate: "hi" } }, "webhooks");
    expect(out.ping).toEqual({ userMessageTemplate: "hi", sessionMode: "ephemeral" });
  });

  it("parses a mail binding", () => {
    const out = parseWebhookMap(
      {
        inbox: {
          source: "atomic-mail",
          userMessageTemplate: "Mail from {{body.from}}",
          email: { allowedSenders: ["boss@example.com"], replyByEmail: true, pollIntervalMs: 120_000 },
        },
      },
      "webhooks",
    );
    expect(out.inbox).toEqual({
      userMessageTemplate: "Mail from {{body.from}}",
      source: "atomic-mail",
      email: { allowedSenders: ["boss@example.com"], pollIntervalMs: 120_000, replyByEmail: true },
      sessionMode: "ephemeral",
    });
  });

  it("requires the email block for a mail binding", () => {
    expect(() =>
      parseWebhookMap({ inbox: { source: "atomic-mail", userMessageTemplate: "x" } }, "webhooks"),
    ).toThrow(/allowedSenders/);
  });

  it("rejects an email block on an http binding", () => {
    expect(() =>
      parseWebhookMap(
        { ping: { userMessageTemplate: "x", email: { allowedSenders: [] } } },
        "webhooks",
      ),
    ).toThrow(ConfigValidationError);
  });

  it("rejects an unknown source and a schedule on a mail binding", () => {
    expect(() =>
      parseWebhookMap({ a: { source: "imap", userMessageTemplate: "x" } }, "webhooks"),
    ).toThrow(/http\|atomic-mail/);
    expect(() =>
      parseWebhookMap(
        {
          a: {
            source: "atomic-mail",
            userMessageTemplate: "x",
            email: { allowedSenders: [] },
            schedule: { kind: "interval", everyMs: 60_000 },
          },
        },
        "webhooks",
      ),
    ).toThrow(/schedule|not allowed/);
  });
});
