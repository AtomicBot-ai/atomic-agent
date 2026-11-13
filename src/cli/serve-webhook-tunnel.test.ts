import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { getWebhookTunnelStatus } from "../http/index.js";
import { startTestHarness, type Harness } from "../http/test-harness.js";

import type { SpawnLike } from "./cloudflared.js";
import { startWebhookTunnel, tunnelPreflight, type WebhookTunnel } from "./serve-webhook-tunnel.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

const found = () => "/usr/local/bin/cloudflared";

const STRIPE_SECRET = "whsec_synthetic-stripe-secret";
const STANDARD_KEY = Buffer.from("synthetic-standard-key-bytes");
const STANDARD_SECRET = `whsec_${STANDARD_KEY.toString("base64")}`;

function githubHeaders(body: string, delivery: string): Record<string, string> {
  const sig = createHmac("sha256", "gh-secret-0123456789").update(body).digest("hex");
  return {
    "content-type": "application/json",
    "x-github-event": "push",
    "x-github-delivery": delivery,
    "x-hub-signature-256": `sha256=${sig}`,
  };
}

function stripeHeaders(body: string, ageSeconds = 0): Record<string, string> {
  const t = Math.floor(Date.now() / 1000) - ageSeconds;
  const sig = createHmac("sha256", STRIPE_SECRET).update(`${t}.${body}`).digest("hex");
  return { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` };
}

function standardHeaders(body: string, id: string, ageSeconds = 0): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const sig = createHmac("sha256", STANDARD_KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  };
}

describe("tunnelPreflight (ATO-625)", () => {
  it("refuses without cloudflared on PATH and says how to install it", () => {
    const res = tunnelPreflight({ webhooks: { gh: { userMessageTemplate: "x", secret: "s" } }, tasksEnabled: true, findBinary: () => null });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("cloudflared");
      expect(res.error).toContain("brew install cloudflared");
    }
  });

  it("refuses when no webhooks are configured", () => {
    const res = tunnelPreflight({ webhooks: {}, tasksEnabled: true, findBinary: found });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("no webhooks are configured") });
  });

  it("refuses when no webhook has a secret, naming them", () => {
    const res = tunnelPreflight({
      webhooks: { open: { userMessageTemplate: "x" }, blank: { userMessageTemplate: "x", secret: "" } },
      tasksEnabled: true,
      findBinary: found,
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("no webhook has a secret (open, blank)") });
  });

  it("refuses when tasks are off", () => {
    const res = tunnelPreflight({ webhooks: { gh: { userMessageTemplate: "x", secret: "s" } }, tasksEnabled: false, findBinary: found });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("tasks are off") });
  });

  it("starts with the secret ones and lists the rest as unreachable", () => {
    const res = tunnelPreflight({
      webhooks: { gh: { userMessageTemplate: "x", secret: "s" }, open: { userMessageTemplate: "x" } },
      tasksEnabled: true,
      findBinary: found,
    });
    expect(res).toEqual({ ok: true, binary: found(), reachable: ["gh"], withoutSecret: ["open"] });
  });
});

describe("startWebhookTunnel gateway (ATO-625)", () => {
  let harness: Harness | null = null;
  let tunnel: WebhookTunnel | null = null;

  afterEach(async () => {
    if (tunnel) await tunnel.stop();
    tunnel = null;
    if (harness) await harness.cleanup();
    harness = null;
  });

  async function boot(child: FakeChild): Promise<{ gateway: string; lines: string[]; args: readonly string[] }> {
    harness = await startTestHarness({
      webhooks: {
        gh: { userMessageTemplate: "push {{body.ref}}", secret: "gh-secret-0123456789", verify: "github" },
        pay: { userMessageTemplate: "stripe {{event}}", secret: STRIPE_SECRET, verify: "stripe" },
        std: { userMessageTemplate: "std {{event}}", secret: STANDARD_SECRET, verify: "standard-webhooks" },
        open: { userMessageTemplate: "open" },
      },
    });
    const lines: string[] = [];
    let args: readonly string[] = [];
    const spawn: SpawnLike = (_command, a) => {
      args = a;
      return child as unknown as ChildProcess;
    };
    tunnel = await startWebhookTunnel({
      runtime: harness.runtime,
      request: { mode: "quick" },
      preflight: { ok: true, binary: "cloudflared", reachable: ["gh", "pay", "std"], withoutSecret: ["open"] },
      approvalBus: harness.approvalBus,
      completionRegistry: harness.completionRegistry,
      write: (line) => lines.push(line),
      spawn,
    });
    return { gateway: `http://127.0.0.1:${tunnel.gatewayPort}`, lines, args };
  }

  it("points cloudflared at the gateway port, not the main API", async () => {
    const { args } = await boot(new FakeChild());
    const harnessPort = new URL(harness!.baseUrl).port;
    expect(args).toContain(`http://127.0.0.1:${tunnel!.gatewayPort}`);
    expect(String(tunnel!.gatewayPort)).not.toBe(harnessPort);
  });

  it("serves nothing but POST /api/webhooks/{name}", async () => {
    const { gateway } = await boot(new FakeChild());
    const probes: Array<[string, string]> = [
      ["GET", "/health"],
      ["GET", "/v1/models"],
      ["POST", "/v1/chat/completions"],
      ["GET", "/api/config"],
      ["PUT", "/api/config"],
      ["GET", "/api/sessions"],
      ["GET", "/api/webhooks"],
      ["GET", "/api/webhooks/gh"],
      ["GET", "/api/events"],
      ["GET", "/panel"],
      ["POST", "/api/skills/install"],
      ["POST", "/api/webhooks/gh/../../config"],
      ["POST", "/api/webhooks"],
      // ATO-445's admin routes live on the main API only.
      ["DELETE", "/api/webhooks/gh"],
    ];
    for (const [method, path] of probes) {
      const res = await fetch(`${gateway}${path}`, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
  });

  it("refuses a binding without a secret, and an unsigned hit on one with a secret", async () => {
    const { gateway } = await boot(new FakeChild());
    const open = await fetch(`${gateway}/api/webhooks/open`, { method: "POST", body: "{}" });
    expect(open.status).toBe(403);
    const unsigned = await fetch(`${gateway}/api/webhooks/gh`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);
    for (const name of ["constructor", "__proto__", "toString"]) {
      const res = await fetch(`${gateway}/api/webhooks/${name}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
    expect(harness!.runtime.taskStore.list().length).toBe(0);
  });

  it("accepts a GitHub-signed delivery and makes a task", async () => {
    const { gateway } = await boot(new FakeChild());
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await fetch(`${gateway}/api/webhooks/gh`, {
      method: "POST",
      headers: githubHeaders(body, "delivery-1"),
      body,
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };
    expect(harness!.runtime.taskStore.get(taskId)?.userMessage).toBe("push refs/heads/main");
  });

  it("runs the same GitHub delivery id once: the repeat is 200 and starts nothing", async () => {
    const { gateway } = await boot(new FakeChild());
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const send = () =>
      fetch(`${gateway}/api/webhooks/gh`, { method: "POST", headers: githubHeaders(body, "delivery-dup"), body });
    expect((await send()).status).toBe(202);
    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ taskId: null, duplicate: true, delivery: "delivery-dup" });
    expect(harness!.runtime.taskStore.list().length).toBe(1);
    const other = await fetch(`${gateway}/api/webhooks/gh`, {
      method: "POST",
      headers: githubHeaders(body, "delivery-other"),
      body,
    });
    expect(other.status).toBe(202);
    expect(harness!.runtime.taskStore.list().length).toBe(2);
  });

  it("runs the same Stripe event id once, and Standard Webhooks webhook-id once", async () => {
    const { gateway } = await boot(new FakeChild());
    const stripeBody = JSON.stringify({ id: "evt_synthetic_1", type: "invoice.paid" });
    const pay = () =>
      fetch(`${gateway}/api/webhooks/pay`, { method: "POST", headers: stripeHeaders(stripeBody), body: stripeBody });
    expect((await pay()).status).toBe(202);
    const payAgain = await pay();
    expect(payAgain.status).toBe(200);
    expect(await payAgain.json()).toMatchObject({ taskId: null, duplicate: true, delivery: "evt_synthetic_1" });

    const stdBody = JSON.stringify({ type: "thing.happened" });
    const std = () =>
      fetch(`${gateway}/api/webhooks/std`, { method: "POST", headers: standardHeaders(stdBody, "msg_synthetic_1"), body: stdBody });
    expect((await std()).status).toBe(202);
    expect((await std()).status).toBe(200);
    expect(harness!.runtime.taskStore.list().length).toBe(2);
  });

  it("rejects a Standard Webhooks or Stripe signature made 6 minutes ago", async () => {
    const { gateway } = await boot(new FakeChild());
    const stdBody = JSON.stringify({ type: "thing.happened" });
    const std = await fetch(`${gateway}/api/webhooks/std`, {
      method: "POST",
      headers: standardHeaders(stdBody, "msg_stale", 6 * 60),
      body: stdBody,
    });
    expect(std.status).toBe(401);
    expect(await std.text()).toContain("stale_timestamp");

    const stripeBody = JSON.stringify({ id: "evt_stale", type: "invoice.paid" });
    const pay = await fetch(`${gateway}/api/webhooks/pay`, {
      method: "POST",
      headers: stripeHeaders(stripeBody, 6 * 60),
      body: stripeBody,
    });
    expect(pay.status).toBe(401);
    expect(await pay.text()).toContain("stale_timestamp");
    expect(harness!.runtime.taskStore.list().length).toBe(0);
  });

  it("reports the public URL, lists it on GET /api/webhooks, and stops cloudflared", async () => {
    const child = new FakeChild();
    const { lines } = await boot(child);
    expect(getWebhookTunnelStatus().state).toBe("starting");
    child.stderr.write("INF |  https://calm-sea-cat-dog.trycloudflare.com  |\n");
    await expect(tunnel!.ready).resolves.toBe("https://calm-sea-cat-dog.trycloudflare.com");
    expect(getWebhookTunnelStatus()).toEqual({
      state: "up",
      mode: "quick",
      publicUrl: "https://calm-sea-cat-dog.trycloudflare.com",
      error: null,
    });
    expect(lines.join("")).toContain("webhook gh: https://calm-sea-cat-dog.trycloudflare.com/api/webhooks/gh");
    expect(lines.join("")).toContain("not reachable without a secret: open");

    const list = await fetch(`${harness!.baseUrl}/api/webhooks`);
    expect(list.status).toBe(200);
    const payload = (await list.json()) as {
      webhooks: Array<{ name: string; hasSecret: boolean; publicUrl: string | null }>;
    };
    expect(JSON.stringify(payload)).not.toContain("gh-secret-0123456789");
    expect(payload.webhooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gh", hasSecret: true, publicUrl: "https://calm-sea-cat-dog.trycloudflare.com/api/webhooks/gh" }),
        expect.objectContaining({ name: "open", hasSecret: false, publicUrl: null }),
      ]),
    );

    const port = tunnel!.gatewayPort;
    await tunnel!.stop();
    tunnel = null;
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(getWebhookTunnelStatus().state).toBe("off");
    await expect(fetch(`http://127.0.0.1:${port}/api/webhooks/gh`, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("marks the tunnel failed when cloudflared dies", async () => {
    const child = new FakeChild();
    const { lines } = await boot(child);
    child.emit("exit", 1, null);
    await expect(tunnel!.ready).resolves.toBeNull();
    expect(getWebhookTunnelStatus().state).toBe("failed");
    expect(lines.join("")).toContain("cloudflared exited (code 1)");
  });
});
