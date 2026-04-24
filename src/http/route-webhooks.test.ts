import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface WebhookResponse {
  taskId: string;
  sessionId: string | null;
}

describe("POST /api/webhooks/:name", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it("materialises an ephemeral task when no sessionMode is set", async () => {
    harness = await startTestHarness({
      webhooks: {
        ping: {
          userMessageTemplate: "hello {{body.who}}",
        },
      },
    });

    const res = await fetch(`${harness.baseUrl}/api/webhooks/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ who: "omnissiah" }),
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as WebhookResponse;
    expect(payload.taskId).toMatch(/^t-/);
    const task = harness.runtime.taskStore.get(payload.taskId);
    expect(task).not.toBeNull();
    expect(task?.userMessage).toBe("hello omnissiah");
    expect(task?.triggerSource).toBe("webhook");
    expect(task?.sessionId).toBeNull();
  });

  it("reuses the persistent session across hits", async () => {
    harness = await startTestHarness({
      webhooks: {
        daily: {
          userMessageTemplate: "tick {{body.n}}",
          sessionMode: "persistent",
        },
      },
    });

    const first = (await fetch(`${harness.baseUrl}/api/webhooks/daily`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    }).then((r) => r.json())) as WebhookResponse;

    const second = (await fetch(`${harness.baseUrl}/api/webhooks/daily`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 2 }),
    }).then((r) => r.json())) as WebhookResponse;

    expect(first.sessionId).not.toBeNull();
    expect(second.sessionId).toBe(first.sessionId);
    const file = join(harness.stateDir, "webhook-sessions.json");
    expect(existsSync(file)).toBe(true);
    const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(map.daily).toBe(first.sessionId);
  });

  it("rejects when sessionMode=named without a secret matches and fails when missing", async () => {
    harness = await startTestHarness({
      webhooks: {
        secure: {
          userMessageTemplate: "auth {{body.hi}}",
          secret: "sekret",
        },
      },
    });

    const bad = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hi: "x" }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": "sekret",
      },
      body: JSON.stringify({ hi: "x" }),
    });
    expect(good.status).toBe(202);
  });

  it("returns 404 for unknown webhook names", async () => {
    harness = await startTestHarness();
    const res = await fetch(`${harness.baseUrl}/api/webhooks/nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("passes schedule through so the task is marked recurring", async () => {
    harness = await startTestHarness({
      webhooks: {
        cronhook: {
          userMessageTemplate: "cron hit {{body.tag}}",
          sessionMode: "persistent",
          schedule: {
            kind: "interval",
            everyMs: 60_000,
          },
        },
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks/cronhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "a" }),
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as WebhookResponse;
    const task = harness.runtime.taskStore.get(payload.taskId);
    expect(task?.recurring).toBe(true);
    expect(task?.schedule?.kind).toBe("interval");
    expect(task?.scheduledFor).not.toBeNull();
  });
});
