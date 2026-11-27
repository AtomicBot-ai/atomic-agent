import { describe, expect, it } from "vitest";

import { LINEAR_API_KEY_KEY, LINEAR_WEBHOOK_SECRET_KEY } from "../channels/linear/index.js";
import { findIntegration, listIntegrations } from "./integration-registry.js";
import { linearIntegration } from "./linear-integration.js";

const ME = "2f1c0a4e-1b2c-4d5e-8f90-123456789abc";

function ctx(present: string[], linear?: Record<string, unknown>) {
  return {
    presentFields: new Set(present),
    configured: ["apiKey", "ownerIds"].every((f) => present.includes(f)),
    ...(linear ? { config: { channels: { linear } } } : {}),
  };
}

describe("linearIntegration (ATO-2464)", () => {
  it("is in the hub, after Discord", () => {
    const ids = listIntegrations().map((i) => i.id);
    expect(findIntegration("linear")).toBe(linearIntegration);
    expect(ids.indexOf("linear")).toBe(ids.indexOf("discord") + 1);
  });

  it("keeps the key and secret in the key store and the rest in channels.linear", () => {
    const by = Object.fromEntries(linearIntegration.fields.map((f) => [f.key, f]));
    expect(by.apiKey).toMatchObject({ envVar: LINEAR_API_KEY_KEY, secret: true, required: true });
    expect(by.webhookSecret).toMatchObject({ envVar: LINEAR_WEBHOOK_SECRET_KEY, secret: true, required: false });
    expect(by.ownerIds).toMatchObject({ store: "config", kind: "list", configPath: "channels.linear.ownerIds" });
    expect(by.enabled).toMatchObject({ kind: "boolean", configPath: "channels.linear.enabled" });
    expect(by.mode).toMatchObject({ store: "config", configPath: "channels.linear.options.mode" });
    expect(linearIntegration.appliesLive).toBe(false);
  });

  it("checks owner ids, mode and key shape at entry", () => {
    const by = Object.fromEntries(linearIntegration.fields.map((f) => [f.key, f]));
    expect(by.ownerIds!.validate!(ME)).toBeUndefined();
    expect(by.ownerIds!.validate!("me")).toMatch(/uuid/);
    expect(by.mode!.validate!("poll")).toBeUndefined();
    expect(by.mode!.validate!("push")).toMatch(/poll or webhook/);
    expect(by.apiKey!.validate!("lin_api_" + "a".repeat(40))).toBeUndefined();
    expect(by.apiKey!.validate!("two words")).toMatch(/lin_api_/);
  });

  it("status: no key, no owner, off, polling, and webhook without its secret", () => {
    expect(linearIntegration.status(ctx([])).detail).toBe("no API key");
    expect(linearIntegration.status(ctx(["apiKey"])).detail).toMatch(/no owner/);
    const both = ["apiKey", "ownerIds", "enabled"];
    expect(linearIntegration.status(ctx(both, { enabled: false }))).toEqual({ level: "configured", detail: "channel off" });
    expect(linearIntegration.status(ctx(both, { enabled: true })).detail).toMatch(/polling/);
    expect(linearIntegration.status(ctx(both, { enabled: true, options: { mode: "webhook" } })).level).toBe("error");
    expect(linearIntegration.status(ctx([...both, "webhookSecret"], { enabled: true })).detail).toMatch(/webhook/);
  });
});
