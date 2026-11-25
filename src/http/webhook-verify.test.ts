import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import {
  checkSharedSecret,
  describeWebhookEvent,
  readStandardWebhookHeaders,
  webhookEventAllowed,
} from "./webhook-verify.js";
import { renderWebhookTemplate } from "./webhook-template.js";
import type { WebhookConfig } from "../config/index.js";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const github: WebhookConfig = {
  userMessageTemplate: "x",
  secret: "synthetic",
  verify: "github",
};

describe("describeWebhookEvent", () => {
  it("reads GitHub's event header, payload action and delivery id", () => {
    const hit = describeWebhookEvent(
      github,
      request({ "x-github-event": "pull_request", "x-github-delivery": "d-1" }),
      { action: "opened" },
    );
    expect(hit).toEqual({ event: "pull_request", action: "opened", delivery: "d-1" });
  });

  it("reads the Standard Webhooks payload type and webhook-id", () => {
    const hit = describeWebhookEvent(
      { ...github, verify: "standard-webhooks" },
      request({ "webhook-id": "msg_1" }),
      { type: "github.star.added", data: {} },
    );
    expect(hit).toEqual({ event: "github.star.added", action: "", delivery: "msg_1" });
  });

  it("reads svix-id as the delivery when the sender uses svix-* headers", () => {
    const hit = describeWebhookEvent(
      { ...github, verify: "standard-webhooks" },
      request({ "svix-id": "msg_svix" }),
      { type: "email.sent" },
    );
    expect(hit).toEqual({ event: "email.sent", action: "", delivery: "msg_svix" });
  });

  it("names nothing for the shared-secret scheme or a non-object body", () => {
    expect(describeWebhookEvent({ userMessageTemplate: "x" }, request({ "x-github-event": "push" }), {})).toEqual({ event: "", action: "", delivery: "" });
    expect(describeWebhookEvent(github, request({ "x-github-event": "push" }), [1, 2])).toEqual({ event: "push", action: "", delivery: "" });
  });
});

describe("readStandardWebhookHeaders", () => {
  const svix = { "svix-id": "msg_s", "svix-timestamp": "2", "svix-signature": "v1,s" };

  it("falls back to the svix-* names", () => {
    expect(readStandardWebhookHeaders(request(svix))).toEqual({ id: "msg_s", timestamp: "2", signature: "v1,s" });
  });

  it("prefers the webhook-* set and never mixes the two", () => {
    expect(readStandardWebhookHeaders(request({ ...svix, "webhook-id": "msg_w" }))).toEqual({ id: "msg_w", timestamp: null, signature: null });
    expect(readStandardWebhookHeaders(request({ ...svix, "webhook-signature": "v1,w" }))).toEqual({ id: null, timestamp: null, signature: "v1,w" });
  });

  it("reads nothing when neither set is sent", () => {
    expect(readStandardWebhookHeaders(request({}))).toEqual({ id: null, timestamp: null, signature: null });
  });
});

describe("webhookEventAllowed", () => {
  const opened = { event: "pull_request", action: "opened", delivery: "" };

  it("lets everything in without a filter", () => {
    expect(webhookEventAllowed(undefined, opened)).toBe(true);
  });

  it("matches an event name or event plus action", () => {
    expect(webhookEventAllowed(["pull_request"], opened)).toBe(true);
    expect(webhookEventAllowed(["pull_request.opened"], opened)).toBe(true);
    expect(webhookEventAllowed(["pull_request.closed"], opened)).toBe(false);
    expect(webhookEventAllowed(["issues"], opened)).toBe(false);
  });

  it("does not match an event-plus-action entry when the payload has no action", () => {
    expect(webhookEventAllowed(["push.opened"], { event: "push", action: "", delivery: "" })).toBe(false);
  });

  it("refuses a hit with no event name once a filter is set", () => {
    expect(webhookEventAllowed(["push"], { event: "", action: "", delivery: "" })).toBe(false);
  });
});

describe("checkSharedSecret", () => {
  it("passes a binding without a secret and checks one that has it", () => {
    expect(checkSharedSecret({ userMessageTemplate: "x" }, request({}))).toBe(true);
    const hook = { userMessageTemplate: "x", secret: "sekret" };
    expect(checkSharedSecret(hook, request({ "x-webhook-secret": "sekret" }))).toBe(true);
    expect(checkSharedSecret(hook, request({ "x-webhook-secret": "nope" }))).toBe(false);
    expect(checkSharedSecret(hook, request({}))).toBe(false);
  });
});

describe("renderWebhookTemplate variables", () => {
  it("fills single-word variables next to body paths", () => {
    expect(renderWebhookTemplate(
      "on {{event}} {{action}} #{{body.number}} ({{delivery}})",
      { number: 7 },
      { event: "pull_request", action: "opened", delivery: "d-1" },
    )).toBe("on pull_request opened #7 (d-1)");
  });

  it("keeps the old behaviour without variables", () => {
    expect(renderWebhookTemplate("{{event}}|{{body}}|{{toString}}", { a: 1 })).toBe('|{"a":1}|');
    expect(renderWebhookTemplate("{{toString}}", {}, { event: "x" })).toBe("");
  });
});
