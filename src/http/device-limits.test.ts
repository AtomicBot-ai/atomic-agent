import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmptySessionState } from "../session/index.js";

import { DEVICE_COOKIE } from "./device-auth.js";
import { createDeviceSessions, type DeviceSessions } from "./device-sessions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * ATO-2308 review: a paired phone (member role by cookie) answers
 * approvals one at a time. It cannot save an Always allow rule and cannot
 * move a chat to another folder; the serve key still can.
 */
const KEY = "k".repeat(32);

let harness: Harness;
let devices: DeviceSessions;
let devicesDir: string;
beforeEach(async () => {
  devicesDir = mkdtempSync(join(tmpdir(), "atag-device-limits-"));
  devices = createDeviceSessions(devicesDir);
  harness = await startTestHarness({ approvalLevel: 1, apiKey: KEY, deviceSessions: devices });
});
afterEach(async () => {
  await harness.cleanup();
  rmSync(devicesDir, { recursive: true, force: true });
});

function phoneSecret(): string {
  const made = devices.createPairing();
  if (!made.ok) throw new Error(made.error);
  const redeemed = devices.redeem(made.token, "iPhone");
  if (!redeemed.ok) throw new Error(redeemed.error);
  return redeemed.secret;
}

interface Answer {
  status: number;
  code: string | null;
}

/** node:http, so the Cookie and Origin headers go out as written. */
function post(path: string, body: unknown, headers: Record<string, string>): Promise<Answer> {
  const port = harness.handle.port;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let code: string | null = null;
          try {
            code = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: string } }).error?.code ?? null;
          } catch {
            code = null;
          }
          resolve({ status: res.statusCode ?? 0, code });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const asPhone = (secret: string) => ({
  cookie: `${DEVICE_COOKIE}=${secret}`,
  origin: `http://127.0.0.1:${harness.handle.port}`,
});
const asKey = () => ({ authorization: `Bearer ${KEY}` });

function askGitStatus(approvalId: string) {
  return harness.runtime.approvals.request({
    sessionId: "s-phone",
    tool: "os.shell.run",
    category: "shell",
    reason: "test",
    commandShape: "git",
    commandArgv: ["git", "status", "-s"],
    workdir: harness.workingDir,
    approvalId,
  });
}

describe("paired phone and approvals", () => {
  it("refuses allow-always from a device cookie, records no rule, and keeps the request pending", async () => {
    const pending = askGitStatus("a-phone-always");
    const out = await post("/api/approval/resolve", { approvalId: "a-phone-always", decision: "allow-always" }, asPhone(phoneSecret()));
    expect(out).toEqual({ status: 403, code: "device_cannot_allow_always" });
    expect(harness.runtime.approvals.isPending("a-phone-always")).toBe(true);
    expect(harness.runtime.approvals.getRules()?.list()).toEqual([]);
    await post("/api/approval/resolve", { approvalId: "a-phone-always", decision: "deny" }, asKey());
    expect((await pending).approved).toBe(false);
  });

  it("still lets a device cookie answer allow-once and deny", async () => {
    const secret = phoneSecret();
    const once = askGitStatus("a-phone-once");
    expect((await post("/api/approval/resolve", { approvalId: "a-phone-once", decision: "allow-once" }, asPhone(secret))).status)
      .toBe(200);
    expect((await once).approved).toBe(true);
    const denied = askGitStatus("a-phone-deny");
    expect((await post("/api/approval/resolve", { approvalId: "a-phone-deny", decision: "deny" }, asPhone(secret))).status)
      .toBe(200);
    expect((await denied).approved).toBe(false);
    expect(harness.runtime.approvals.getRules()?.list()).toEqual([]);
  });

  it("leaves allow-always with the serve key as it was", async () => {
    const pending = askGitStatus("a-key-always");
    expect((await post("/api/approval/resolve", { approvalId: "a-key-always", decision: "allow-always" }, asKey())).status)
      .toBe(200);
    expect((await pending).approved).toBe(true);
    expect(harness.runtime.approvals.getRules()?.list()).toHaveLength(1);
  });
});

describe("paired phone and a chat's folder", () => {
  it("refuses a folder change from a device cookie and leaves the chat where it was", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-phone", workingDir: harness.workingDir }));
    const other = mkdtempSync(join(tmpdir(), "wd-phone-other-"));
    const out = await post("/api/sessions/wd-phone/working-dir", { workingDir: other }, asPhone(phoneSecret()));
    expect(out).toEqual({ status: 403, code: "device_cannot_change_folder" });
    expect(harness.runtime.sessionStore.load("wd-phone")?.workingDir).toBe(harness.workingDir);
    rmSync(other, { recursive: true, force: true });
  });

  it("leaves a folder change with the serve key as it was", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-key", workingDir: harness.workingDir }));
    const other = mkdtempSync(join(tmpdir(), "wd-key-other-"));
    expect((await post("/api/sessions/wd-key/working-dir", { workingDir: other }, asKey())).status).toBe(200);
    expect(harness.runtime.sessionStore.load("wd-key")?.workingDir).toBe(other);
    rmSync(other, { recursive: true, force: true });
  });
});

describe("paired phone and starting work in another folder", () => {
  let other: string;
  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), "wd-start-"));
  });
  afterEach(() => {
    rmSync(other, { recursive: true, force: true });
  });

  const chatBody = (extra: Record<string, unknown> = {}) => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra });

  async function newIdeas(): Promise<Array<{ id: string; status: string; sourceTaskId: string | null }>> {
    const res = await fetch(`${harness.baseUrl}/api/ideas?status=new`, { headers: asKey() });
    return ((await res.json()) as { ideas: Array<{ id: string; status: string; sourceTaskId: string | null }> }).ideas;
  }

  it("refuses POST /api/tasks with workingDir from a device cookie, and files no task", async () => {
    const before = harness.runtime.taskStore.list().length;
    const out = await post("/api/tasks", { userMessage: "tidy the repo", workingDir: other }, asPhone(phoneSecret()));
    expect(out).toEqual({ status: 403, code: "device_cannot_change_folder" });
    expect(harness.runtime.taskStore.list()).toHaveLength(before);
  });

  it("leaves POST /api/tasks with workingDir and the serve key as it was", async () => {
    const out = await post("/api/tasks", { userMessage: "tidy the repo", workingDir: other, maxAttempts: 1 }, asKey());
    expect(out.status).toBe(201);
  });

  it("refuses working_dir on /v1/chat/completions, /v1/responses and /v1/messages from a device cookie", async () => {
    const phone = asPhone(phoneSecret());
    expect(await post("/v1/chat/completions", chatBody({ working_dir: other }), phone))
      .toEqual({ status: 403, code: "device_cannot_change_folder" });
    expect(await post("/v1/responses", { model: "m", input: "hi", working_dir: other }, phone))
      .toEqual({ status: 403, code: "device_cannot_change_folder" });
    // The Anthropic error body has no `code`; the status is passed through.
    expect((await post("/v1/messages", { ...chatBody({ working_dir: other }), max_tokens: 16 }, phone)).status).toBe(403);
  });

  it("still lets a device cookie chat in the default folder", async () => {
    expect((await post("/v1/chat/completions", chatBody(), asPhone(phoneSecret()))).status).toBe(200);
  });

  it("leaves working_dir on /v1/chat/completions with the serve key as it was", async () => {
    expect((await post("/v1/chat/completions", chatBody({ working_dir: other }), asKey())).status).toBe(200);
  });

  it("refuses a goal that opens a new chat in a given folder from a device cookie", async () => {
    const out = await post("/api/sessions/goal-phone-1/goal", { action: "set", criteria: ["ship it"], workingDir: other }, asPhone(phoneSecret()));
    expect(out).toEqual({ status: 403, code: "device_cannot_change_folder" });
    expect(harness.runtime.sessionStore.load("goal-phone-1")).toBeFalsy();
  });

  it("refuses a Retry idea that reopens a folder from a device cookie, and puts the idea back", async () => {
    const session = harness.runtime.createSession({ metadata: { source: "http-task" }, persist: false });
    harness.runtime.sessionStore.save({ ...session, workingDir: other });
    const store = harness.runtime.taskStore;
    const original = store.create({ sessionId: session.id, userMessage: "run the report", origin: "http", maxAttempts: 1 });
    store.markRunning(original.id);
    store.markFailed(original.id, { category: "transport", message: "provider timed out" });
    expect((await post("/api/ideas/refresh", {}, asKey())).status).toBe(200);
    const idea = (await newIdeas()).find((i) => i.sourceTaskId === original.id);
    if (!idea) throw new Error("no retry idea offered");

    const out = await post(`/api/ideas/${idea.id}/accept`, {}, asPhone(phoneSecret()));
    expect(out).toEqual({ status: 403, code: "device_cannot_change_folder" });
    expect((await newIdeas()).map((i) => i.id)).toContain(idea.id);
    // The serve key still accepts it, in the original's folder.
    expect((await post(`/api/ideas/${idea.id}/accept`, {}, asKey())).status).toBe(200);
  });
});
