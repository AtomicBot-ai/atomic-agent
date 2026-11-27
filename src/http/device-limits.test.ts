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
