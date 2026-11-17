import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/* ATO-438: GitHub and Standard Webhooks signatures on POST /api/webhooks/:name. */

const GITHUB_SECRET = "synthetic-github-secret";
const KEY = Buffer.from("synthetic-standard-key-bytes");
const STANDARD_SECRET = `whsec_${KEY.toString("base64")}`;

interface Reply {
  taskId: string | null;
  duplicate?: boolean;
  ignored?: boolean;
}

function githubHeaders(body: string, event: string, secret = GITHUB_SECRET): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "delivery-synthetic-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function standardHeaders(body: string, id: string, timestampS: number): Record<string, string> {
  const ts = String(timestampS);
  const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  };
}

const nowS = (): number => Math.floor(Date.now() / 1000);

describe("POST /api/webhooks/:name with verify=github", () => {
  let harness: Harness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function start(events?: string[]): Promise<void> {
    harness = await startTestHarness({
      webhooks: {
        gh: {
          userMessageTemplate: "on {{event}} {{action}}: {{body.pull_request.title}}",
          secret: GITHUB_SECRET,
          verify: "github",
          ...(events ? { events } : {}),
        },
      },
    });
  }

  const post = (body: string, headers: Record<string, string>): Promise<Response> =>
    fetch(`${harness.baseUrl}/api/webhooks/gh`, { method: "POST", headers, body });

  it("turns a correctly signed event into a task with the event in the template", async () => {
    await start();
    const body = JSON.stringify({ action: "opened", pull_request: { title: "Fix it" } });
    const res = await post(body, githubHeaders(body, "pull_request"));
    expect(res.status).toBe(202);
    const reply = (await res.json()) as Reply;
    const task = harness.runtime.taskStore.get(reply.taskId ?? "");
    expect(task?.userMessage).toBe("on pull_request opened: Fix it");
  });

  it("verifies the raw bytes, not a re-serialized body", async () => {
    await start();
    const body = '{ "action" : "opened",\n  "pull_request": { "title": "Spaced" } }';
    const res = await post(body, githubHeaders(body, "pull_request"));
    expect(res.status).toBe(202);
  });

  it("rejects a wrong, missing or body-mismatched signature and starts nothing", async () => {
    await start();
    const body = JSON.stringify({ action: "opened" });
    const wrong = await post(body, githubHeaders(body, "pull_request", "other-secret"));
    expect(wrong.status).toBe(401);
    const missing = githubHeaders(body, "pull_request");
    delete missing["x-hub-signature-256"];
    expect((await post(body, missing)).status).toBe(401);
    const tampered = await post(JSON.stringify({ action: "closed" }), githubHeaders(body, "pull_request"));
    expect(tampered.status).toBe(401);
    const sharedSecretOnly = await post(body, { "content-type": "application/json", "x-webhook-secret": GITHUB_SECRET });
    expect(sharedSecretOnly.status).toBe(401);
    expect(harness.runtime.taskStore.list().length).toBe(0);
  });

  it("answers GitHub's ping without starting a task", async () => {
    await start();
    const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const res = await post(body, githubHeaders(body, "ping"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Reply).taskId).toBeNull();
    expect(harness.runtime.taskStore.list().length).toBe(0);
  });

  it("runs only the listed events and actions", async () => {
    await start(["pull_request.opened", "issues"]);
    const opened = JSON.stringify({ action: "opened", pull_request: { title: "a" } });
    expect((await post(opened, githubHeaders(opened, "pull_request"))).status).toBe(202);
    const closed = JSON.stringify({ action: "closed", pull_request: { title: "a" } });
    const skipped = await post(closed, githubHeaders(closed, "pull_request"));
    expect(skipped.status).toBe(200);
    expect(((await skipped.json()) as Reply).ignored).toBe(true);
    const issue = JSON.stringify({ action: "edited" });
    expect((await post(issue, githubHeaders(issue, "issues"))).status).toBe(202);
    const push = JSON.stringify({ ref: "refs/heads/main" });
    expect((await post(push, githubHeaders(push, "push"))).status).toBe(200);
    expect(harness.runtime.taskStore.list().length).toBe(2);
  });
});

describe("POST /api/webhooks/:name with verify=standard-webhooks", () => {
  let harness: Harness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function start(): Promise<void> {
    harness = await startTestHarness({
      webhooks: {
        composio: {
          userMessageTemplate: "event {{event}} id {{delivery}}",
          secret: STANDARD_SECRET,
          verify: "standard-webhooks",
        },
      },
    });
  }

  const post = (body: string, headers: Record<string, string>): Promise<Response> =>
    fetch(`${harness.baseUrl}/api/webhooks/composio`, { method: "POST", headers, body });

  it("accepts a valid signature and exposes type and id to the template", async () => {
    await start();
    const body = JSON.stringify({ type: "github.pull_request.opened", data: {} });
    const res = await post(body, standardHeaders(body, "msg_synthetic_1", nowS()));
    expect(res.status).toBe(202);
    const reply = (await res.json()) as Reply;
    expect(harness.runtime.taskStore.get(reply.taskId ?? "")?.userMessage).toBe(
      "event github.pull_request.opened id msg_synthetic_1",
    );
  });

  it("starts one task for a replayed message id", async () => {
    await start();
    const body = JSON.stringify({ type: "t", data: {} });
    const headers = standardHeaders(body, "msg_replayed", nowS());
    expect((await post(body, headers)).status).toBe(202);
    const replay = await post(body, headers);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Reply).duplicate).toBe(true);
    const other = JSON.stringify({ type: "t", data: { n: 2 } });
    expect((await post(other, standardHeaders(other, "msg_fresh", nowS()))).status).toBe(202);
    expect(harness.runtime.taskStore.list().length).toBe(2);
  });

  it("rejects an old timestamp even with a valid signature", async () => {
    await start();
    const body = JSON.stringify({ type: "t" });
    const res = await post(body, standardHeaders(body, "msg_old", nowS() - 6 * 60));
    expect(res.status).toBe(401);
    expect(harness.runtime.taskStore.list().length).toBe(0);
  });

  it("rejects missing headers and a wrong signature", async () => {
    await start();
    const body = JSON.stringify({ type: "t" });
    for (const drop of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers = standardHeaders(body, "msg_missing", nowS());
      delete headers[drop];
      expect((await post(body, headers)).status).toBe(401);
    }
    const forged = standardHeaders(body, "msg_forged", nowS());
    forged["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")}`;
    expect((await post(body, forged)).status).toBe(401);
    expect(harness.runtime.taskStore.list().length).toBe(0);
  });

  it("does not let a rejected copy burn the message id", async () => {
    await start();
    const body = JSON.stringify({ type: "t" });
    const forged = standardHeaders(body, "msg_kept", nowS());
    forged["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")}`;
    expect((await post(body, forged)).status).toBe(401);
    expect((await post(body, standardHeaders(body, "msg_kept", nowS()))).status).toBe(202);
  });
});
