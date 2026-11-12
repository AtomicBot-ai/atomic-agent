import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import { parseWebhookMap, type WebhookConfig } from "./webhook-config.js";

/* ATO-438: per-binding verification schemes and the event filter. */

const STANDARD_SECRET = `whsec_${Buffer.from("synthetic-standard-key").toString("base64")}`;

function parsedHook(raw: unknown): WebhookConfig {
  const hook = parseWebhookMap({ ping: raw }, "webhooks").ping;
  if (hook === undefined) throw new Error("parsed webhook fixture is missing");
  return hook;
}

function rejection(raw: unknown): { field: string; reason: string } {
  try {
    parseWebhookMap({ ping: raw }, "webhooks");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }
  throw new Error("expected webhook validation to reject the fixture");
}

describe("webhook verify scheme", () => {
  it("keeps the shared-secret default out of the normalized entry", () => {
    expect(parsedHook({ userMessageTemplate: "event", secret: "s", verify: "secret" })).toStrictEqual({
      userMessageTemplate: "event",
      sessionMode: "ephemeral",
      secret: "s",
    });
    expect(parsedHook({ userMessageTemplate: "event", verify: null })).toStrictEqual({
      userMessageTemplate: "event",
      sessionMode: "ephemeral",
    });
  });

  it("keeps github and standard-webhooks with their events", () => {
    expect(parsedHook({
      userMessageTemplate: "on {{event}}",
      secret: "synthetic-github-secret",
      verify: "github",
      events: ["pull_request.opened", "issues"],
    })).toStrictEqual({
      userMessageTemplate: "on {{event}}",
      sessionMode: "ephemeral",
      secret: "synthetic-github-secret",
      verify: "github",
      events: ["pull_request.opened", "issues"],
    });
    expect(parsedHook({
      userMessageTemplate: "on {{event}}",
      secret: STANDARD_SECRET,
      verify: "standard-webhooks",
    })).toMatchObject({ verify: "standard-webhooks", secret: STANDARD_SECRET });
  });

  it("accepts a standard-webhooks secret without the whsec_ prefix", () => {
    const bare = Buffer.from("synthetic-standard-key").toString("base64");
    expect(parsedHook({ userMessageTemplate: "e", secret: bare, verify: "standard-webhooks" }).secret).toBe(bare);
  });

  it.each([
    [{ userMessageTemplate: "e", verify: "hmac" }, "webhooks.ping.verify", 'expected secret|github|standard-webhooks, got "hmac"'],
    [{ userMessageTemplate: "e", verify: "github" }, "webhooks.ping.secret", "verify=github requires a non-empty secret"],
    [{ userMessageTemplate: "e", verify: "standard-webhooks" }, "webhooks.ping.secret", "verify=standard-webhooks requires a non-empty secret"],
    [{ userMessageTemplate: "e", verify: "standard-webhooks", secret: "whsec_not base64!" }, "webhooks.ping.secret", "verify=standard-webhooks expects a base64 secret such as whsec_<base64>"],
    [{ userMessageTemplate: "e", verify: "standard-webhooks", secret: "whsec_" }, "webhooks.ping.secret", "verify=standard-webhooks expects a base64 secret such as whsec_<base64>"],
    [{ userMessageTemplate: "e", secret: "s", events: ["push"] }, "webhooks.ping.events", "events requires verify=github or verify=standard-webhooks"],
    [{ userMessageTemplate: "e", secret: "s", verify: "github", events: [] }, "webhooks.ping.events", "expected a non-empty array of event names"],
    [{ userMessageTemplate: "e", secret: "s", verify: "github", events: "push" }, "webhooks.ping.events", "expected a non-empty array of event names"],
    [{ userMessageTemplate: "e", secret: "s", verify: "github", events: ["push", ""] }, "webhooks.ping.events[1]", 'expected non-empty string, got ""'],
  ])("rejects %j at the exact field", (raw, field, reason) => {
    expect(rejection(raw)).toMatchObject({ field, reason });
  });

  it("never echoes a rejected standard-webhooks secret", () => {
    const { reason } = rejection({
      userMessageTemplate: "e",
      verify: "standard-webhooks",
      secret: "whsec_synthetic secret!",
    });
    expect(reason).not.toContain("synthetic");
  });
});
