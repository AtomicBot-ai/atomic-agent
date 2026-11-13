import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { generateWebhookSecret } from "./route-webhooks-admin.js";
import { startTestHarness, type Harness } from "./test-harness.js";
import { standardWebhooksKey } from "./webhook-signature.js";

/**
 * ATO-445: the desktop's Webhooks screen lists routes over GET /api/webhooks
 * (ATO-625) and adds and removes them over these. `verify` uses the binding
 * values of ATO-438/ATO-625: secret, github, standard-webhooks, stripe.
 */
describe("/api/webhooks admin routes", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  const configOnDisk = () =>
    JSON.parse(readFileSync(join(harness.stateDir, "config.json"), "utf8")) as {
      webhooks?: Record<string, Record<string, unknown>>;
    };

  const create = (body: unknown) =>
    fetch(`${harness.baseUrl}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET /api/webhooks carries verify, template and live next to the ATO-625 fields", async () => {
    harness = await startTestHarness({
      webhooks: {
        gh: { userMessageTemplate: "t", secret: "top-secret", verify: "github", events: ["push"] },
        plain: { userMessageTemplate: "p" },
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("top-secret");
    const payload = JSON.parse(text) as {
      tunnel: { state: string };
      webhooks: Array<Record<string, unknown>>;
      presets: string[];
    };
    expect(payload.tunnel.state).toBe("off");
    expect(payload.presets).toEqual(["secret", "github", "standard-webhooks", "stripe"]);
    expect(payload.webhooks).toEqual([
      {
        name: "gh",
        path: "/api/webhooks/gh",
        hasSecret: true,
        sessionMode: "ephemeral",
        publicUrl: null,
        verify: "github",
        events: ["push"],
        userMessageTemplate: "t",
        live: true,
      },
      {
        name: "plain",
        path: "/api/webhooks/plain",
        hasSecret: false,
        sessionMode: "ephemeral",
        publicUrl: null,
        verify: "secret",
        userMessageTemplate: "p",
        live: true,
      },
    ]);
  });

  it("shows a route added to config.json by hand since start as not live", async () => {
    harness = await startTestHarness({ webhooks: { running: { userMessageTemplate: "r" } } });
    const file = join(harness.stateDir, "config.json");
    const tree = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
      webhooks: Record<string, unknown>;
    };
    tree.webhooks.later = { userMessageTemplate: "l", secret: "hand-written-secret" };
    writeFileSync(file, JSON.stringify(tree));
    const text = await (await fetch(`${harness.baseUrl}/api/webhooks`)).text();
    expect(text).not.toContain("hand-written-secret");
    const { webhooks } = JSON.parse(text) as { webhooks: Array<Record<string, unknown>> };
    expect(webhooks.map((w) => [w.name, w.live])).toEqual([
      ["running", true],
      ["later", false],
    ]);
  });

  it("creates a github route, returns the secret once, and it answers without a restart", async () => {
    harness = await startTestHarness();
    const res = await create({ name: "gh", verify: "github", userMessageTemplate: "event {{body.action}}" });
    expect(res.status).toBe(201);
    const { webhook, secret } = (await res.json()) as { webhook: Record<string, unknown>; secret: string };
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(webhook).toMatchObject({ name: "gh", verify: "github", hasSecret: true, live: true, publicUrl: null });
    expect(configOnDisk().webhooks?.gh).toMatchObject({ verify: "github", secret });

    const list = await (await fetch(`${harness.baseUrl}/api/webhooks`)).text();
    expect(list).not.toContain(secret);

    const body = '{"action":"opened"}';
    const hit = await fetch(`${harness.baseUrl}/api/webhooks/gh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    expect(hit.status).toBe(202);
  });

  it("needs the pasted signing secret for stripe", async () => {
    harness = await startTestHarness();
    const missing = await create({ name: "pay", verify: "stripe", userMessageTemplate: "paid" });
    expect(missing.status).toBe(400);
    const pasted = await create({ name: "pay", verify: "stripe", userMessageTemplate: "paid", secret: "whsec_abc" });
    expect(pasted.status).toBe(201);
    expect(configOnDisk().webhooks?.pay).toMatchObject({ verify: "stripe", secret: "whsec_abc" });
  });

  it("generates a whsec_ key for standard-webhooks", async () => {
    harness = await startTestHarness();
    const res = await create({ name: "std", verify: "standard-webhooks", userMessageTemplate: "s" });
    expect(res.status).toBe(201);
    const { secret } = (await res.json()) as { secret: string };
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(standardWebhooksKey(secret).length).toBe(24);
    expect(configOnDisk().webhooks?.std).toMatchObject({ verify: "standard-webhooks", secret });
  });

  it("a secret route gets a generated secret and no verify key on disk", async () => {
    harness = await startTestHarness();
    const res = await create({ name: "plain", userMessageTemplate: "p" });
    expect(res.status).toBe(201);
    const { webhook, secret } = (await res.json()) as { webhook: Record<string, unknown>; secret: string };
    expect(webhook).toMatchObject({ verify: "secret", hasSecret: true });
    expect(configOnDisk().webhooks?.plain).toEqual({ userMessageTemplate: "p", secret });
  });

  it("passes events through to the config check", async () => {
    harness = await startTestHarness();
    const ok = await create({ name: "gh", verify: "github", userMessageTemplate: "t", events: ["pull_request.opened"] });
    expect(ok.status).toBe(201);
    expect(configOnDisk().webhooks?.gh?.events).toEqual(["pull_request.opened"]);
    // ATO-438: an events filter needs a signed scheme.
    expect((await create({ name: "plain", userMessageTemplate: "t", events: ["push"] })).status).toBe(400);
    expect((await create({ name: "empty", verify: "github", userMessageTemplate: "t", events: [] })).status).toBe(400);
  });

  it("refuses a duplicate, a bad name, an unknown preset and an empty template", async () => {
    harness = await startTestHarness({ webhooks: { taken: { userMessageTemplate: "t" } } });
    expect((await create({ name: "taken", userMessageTemplate: "x" })).status).toBe(409);
    expect((await create({ name: "has space", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "__proto__", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "ok", verify: "gitlab", userMessageTemplate: "x" })).status).toBe(400);
    // The earlier draft names are not binding values.
    expect((await create({ name: "ok", verify: "header", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "ok", verify: "standard", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "ok", userMessageTemplate: "" })).status).toBe(400);
    expect(Object.keys(configOnDisk().webhooks ?? {})).toEqual(["taken"]);
  });

  it("deletes a route from the file and the running agent", async () => {
    harness = await startTestHarness({
      webhooks: { gone: { userMessageTemplate: "t" }, kept: { userMessageTemplate: "k" } },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks/gone`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(Object.keys(configOnDisk().webhooks ?? {})).toEqual(["kept"]);
    const hit = await fetch(`${harness.baseUrl}/api/webhooks/gone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(hit.status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/webhooks/gone`, { method: "DELETE" })).status).toBe(404);
  });

  it("generateWebhookSecret gives a fresh value each time", () => {
    expect(generateWebhookSecret("secret")).not.toBe(generateWebhookSecret("secret"));
  });
});

/**
 * Decision 2 (ATO-445): the main API port is never exposed. Outside senders
 * reach webhooks only through the tunnel listener (ATO-625), never by
 * binding the main API to a non-loopback address. Nothing this change adds
 * may open that door, from code or from a config write.
 */
describe("webhook admin never moves the main API off loopback", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    join(here, "route-webhooks-admin.ts"),
    join(here, "route-webhooks-list.ts"),
    join(here, "..", "config", "webhook-config.ts"),
  ];

  it.each(sources)("%s has no bind, listen or host path", (file) => {
    const code = readFileSync(file, "utf8");
    expect(code).not.toMatch(/0\.0\.0\.0/);
    expect(code).not.toMatch(/["'`]::["'`]/);
    expect(code).not.toMatch(/\.listen\(/);
    expect(code).not.toMatch(/\bhost\b/i);
  });

  it("a create carrying host or http fields writes only the webhook route", async () => {
    harness = await startTestHarness({ webhooks: {} });
    expect(new URL(harness.baseUrl).hostname).toBe("127.0.0.1");
    const beforeTree = JSON.parse(readFileSync(join(harness.stateDir, "config.json"), "utf8")) as Record<string, unknown>;
    const res = await fetch(`${harness.baseUrl}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "gh",
        verify: "github",
        userMessageTemplate: "t",
        host: "0.0.0.0",
        http: { host: "0.0.0.0", port: 80 },
        bind: "0.0.0.0",
      }),
    });
    expect(res.status).toBe(201);
    const after = readFileSync(join(harness.stateDir, "config.json"), "utf8");
    expect(after).not.toContain("0.0.0.0");
    const tree = JSON.parse(after) as Record<string, unknown> & {
      webhooks: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(tree.webhooks.gh).sort()).toEqual(["secret", "userMessageTemplate", "verify"]);
    for (const key of ["host", "http", "bind"]) expect(tree[key]).toEqual(beforeTree[key]);
    // The agent keeps answering on the same loopback address.
    expect((await fetch(`${harness.baseUrl}/api/webhooks`)).status).toBe(200);
  });
});
