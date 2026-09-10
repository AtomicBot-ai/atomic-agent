import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import type { DownloadJob } from "../local-llm/index.js";
import { AtomicMailService } from "./atomic-mail-service.js";
import { readCachedSession, resolveSessionPath } from "./atomic-mail-store.js";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string): string => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

/** Records sends; answers auth and JMAP like the real service does. */
function fakeOrigin() {
  const sent: Array<{
    to: string;
    subject: string;
    text: string;
    html?: string;
  }> = [];
  let sessions = 0;
  const knobs = { failNextSend: false, rejectCapabilityOnce: false };
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const json = (
        data: unknown,
        extra: Record<string, string> = {},
      ): Response =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json", ...extra },
        });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      if (u.endsWith("/challenge"))
        return json(
          {},
          { authorization: `Bearer ${jwt({ jti: "c", difficulty: 0, exp })}` },
        );
      if (u.endsWith("/session")) {
        sessions += 1;
        return json(body?.username ? { apiKey: "key-xyz" } : {}, {
          authorization: `Bearer ${jwt({ exp })}`,
        });
      }
      if (u.endsWith("/capability")) {
        if (knobs.rejectCapabilityOnce) {
          knobs.rejectCapabilityOnce = false;
          return new Response("{}", { status: 401 });
        }
        return json(
          {},
          {
            authorization: `Bearer ${jwt({ exp: Math.floor(Date.now() / 1000) + 120 })}`,
          },
        );
      }
      if (u.endsWith("/.well-known/jmap")) {
        return json({
          apiUrl: "https://api.test/jmap",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" },
          username: "atag-test01@atomicmail.ai",
        });
      }
      const responses = (
        body.methodCalls as [string, Record<string, unknown>, string][]
      ).map(([name, args, id]) => {
        if (name === "Mailbox/query") return [name, { ids: ["mb"] }, id];
        if (name === "Identity/get")
          return [
            name,
            { list: [{ id: "id-1", email: "atag-test01@atomicmail.ai" }] },
            id,
          ];
        if (name === "Email/set") {
          if (knobs.failNextSend) {
            knobs.failNextSend = false;
            return [
              name,
              {
                notCreated: {
                  d1: {
                    type: "invalidProperties",
                    description: "to: rejected",
                  },
                },
              },
              id,
            ];
          }
          const d = (args.create as Record<string, Record<string, unknown>>).d1;
          const bodies = d.bodyValues as Record<string, { value: string }>;
          sent.push({
            to: (d.to as Array<{ email: string }>)[0]!.email,
            subject: String(d.subject),
            text: bodies.t!.value,
            html: bodies.h?.value,
          });
          return [name, { created: { d1: { id: "e" } } }, id];
        }
        if (name === "EmailSubmission/set")
          return [name, { created: { s1: { id: "s" } } }, id];
        return ["error", { type: "unknownMethod" }, id];
      });
      return json({ methodResponses: responses });
    },
  ) as unknown as typeof fetch;
  return {
    sent,
    fetchImpl,
    sessionCount: () => sessions,
    set failNextSend(v: boolean) {
      knobs.failNextSend = v;
    },
    set rejectCapabilityOnce(v: boolean) {
      knobs.rejectCapabilityOnce = v;
    },
  };
}

describe("AtomicMailService", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mail-svc-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    env = {};
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_MAIL_API_KEY;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function service(
    origin: ReturnType<typeof fakeOrigin>,
    code = "482913",
  ): AtomicMailService {
    return new AtomicMailService({
      fetchImpl: origin.fetchImpl,
      authUrl: "https://auth.test",
      apiUrl: "https://api.test",
      env,
      stateDir,
      makeCode: () => code,
    });
  }

  it("registers the inbox: key to the env file, address to config, session cached", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    expect(svc.readiness()).toEqual({ level: "no_inbox" });
    const { address } = await svc.register("atag-test01");
    expect(address).toBe("atag-test01@atomicmail.ai");
    expect(readFileSync(join(stateDir, ".env"), "utf-8")).toMatch(
      /ATOMIC_MAIL_API_KEY=key-xyz/,
    );
    expect(getConfig().atomicMail).toMatchObject({
      address,
      accountId: "acc",
      ownerVerifiedAt: null,
    });
    expect(readCachedSession(stateDir)?.sessionJwt).toBeTruthy();
    // The process env is where the notifier looks for the key.
    expect(process.env.ATOMIC_MAIL_API_KEY).toBe("key-xyz");
  });

  it("mails a code to the owner, stores only its hash, and verifies the digits typed back", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    expect(svc.readiness()).toEqual({
      level: "no_owner",
      address: "atag-test01@atomicmail.ai",
    });

    await svc.sendCode("valerii@example.com");
    expect(origin.sent).toHaveLength(1);
    expect(origin.sent[0]).toMatchObject({
      to: "valerii@example.com",
      subject: "▶ ACCESS CODE 482913 — Atomic Agent",
    });
    const pending = getConfig().atomicMail.pendingVerification;
    expect(pending?.email).toBe("valerii@example.com");
    expect(pending?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(getConfig().atomicMail)).not.toContain("482913");
    expect(svc.readiness()).toMatchObject({
      level: "unverified",
      ownerEmail: "valerii@example.com",
    });

    expect(svc.verifyCode("000000")).toEqual({
      ok: false,
      reason: "that is not the code in the mail (4 tries left)",
    });
    expect(getConfig().atomicMail.pendingVerification?.attempts).toBe(1);
    expect(svc.verifyCode("482 913")).toEqual({
      ok: true,
      email: "valerii@example.com",
    });
    expect(getConfig().atomicMail.ownerVerifiedAt).toBeTruthy();
    expect(getConfig().atomicMail.pendingVerification).toBeNull();
    expect(svc.readiness()).toEqual({
      level: "ready",
      address: "atag-test01@atomicmail.ai",
      ownerEmail: "valerii@example.com",
    });
    // The cached session served every send: one proof-of-work for the registration only.
    expect(origin.sessionCount()).toBe(1);
  });

  it("throws the code away after five wrong guesses", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    await svc.sendCode("valerii@example.com");
    for (let i = 0; i < 4; i += 1)
      expect(svc.verifyCode("111111").ok).toBe(false);
    expect(svc.verifyCode("111111")).toEqual({
      ok: false,
      reason: "too many wrong guesses — press v to get a new code",
    });
    expect(getConfig().atomicMail.pendingVerification).toBeNull();
    // Even the right code is useless now.
    expect(svc.verifyCode("482913").ok).toBe(false);
  });

  it("a code mail that fails to send changes nothing about the owner", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    await svc.sendCode("first@example.com");
    svc.verifyCode("482913");
    expect(svc.readiness()).toMatchObject({
      level: "ready",
      ownerEmail: "first@example.com",
    });
    origin.failNextSend = true;
    await expect(svc.sendCode("second@example.com")).rejects.toThrow();
    // Still the first, still verified — and never "second".
    expect(getConfig().atomicMail).toMatchObject({
      ownerEmail: "first@example.com",
      pendingVerification: null,
    });
    expect(getConfig().atomicMail.ownerVerifiedAt).toBeTruthy();
  });

  it("logs in again once when the cached session is refused, instead of failing for an hour", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    // A new process: the session cache on disk is fresh, the capability is not.
    const later = service(origin);
    origin.rejectCapabilityOnce = true;
    await later.sendCode("valerii@example.com");
    expect(origin.sent).toHaveLength(1);
    // The second session came from a fresh login, not the dead cache.
    expect(origin.sessionCount()).toBe(2);
  });

  it("reconnect drops the cached session and discovers the address behind a pasted key", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "another-key";
    const { address } = await svc.reconnect();
    expect(address).toBe("atag-test01@atomicmail.ai");
    expect(origin.sessionCount()).toBe(2);
    delete env.ATOMIC_MAIL_API_KEY;
    expect(await svc.reconnect()).toEqual({ address: null });
    expect(getConfig().atomicMail.address).toBeNull();
    expect(readCachedSession(stateDir)).toBeNull();
  });

  it("refuses a code that expired, and says how to get another", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    await svc.sendCode("valerii@example.com");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(svc.verifyCode("482913")).toEqual({
        ok: false,
        reason: "that code has expired — press v to get a new one",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the download mail only to a verified owner", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    const job = {
      version: 1,
      id: "chat-q",
      kind: "chat",
      modelId: "q",
      mode: "gguf-only",
      pid: 1,
      status: "done",
      phase: "gguf",
      label: "Qwen 3.5 4B (gguf)",
      percent: 100,
      transferredBytes: 10,
      totalBytes: 10,
      error: null,
      waiting: null,
      resumable: false,
      startedAt: "2026-09-08T10:00:00.000Z",
      updatedAt: "2026-09-08T10:01:00.000Z",
      finishedAt: "2026-09-08T10:01:00.000Z",
    } as DownloadJob;
    await expect(svc.sendDownloadMail(job)).rejects.toThrow(
      /no Atomic Mail inbox/,
    );
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    await svc.sendCode("valerii@example.com");
    await expect(svc.sendDownloadMail(job)).rejects.toThrow(/not verified/);
    svc.verifyCode("482913");
    await svc.sendDownloadMail(job);
    expect(origin.sent.at(-1)).toMatchObject({
      to: "valerii@example.com",
      subject: "▶ MODEL READY: Qwen 3.5 4B",
    });
    expect(origin.sent.at(-1)!.html).toContain("<pre");
  });

  it("forgets the inbox on this machine", async () => {
    const origin = fakeOrigin();
    const svc = service(origin);
    await svc.register("atag-test01");
    env.ATOMIC_MAIL_API_KEY = "key-xyz";
    svc.forget();
    // The writer drops the file once its last key is gone.
    const dotenv = existsSync(join(stateDir, ".env"))
      ? readFileSync(join(stateDir, ".env"), "utf-8")
      : "";
    expect(dotenv).not.toMatch(/key-xyz/);
    expect(process.env.ATOMIC_MAIL_API_KEY).toBeUndefined();
    expect(getConfig().atomicMail.address).toBeNull();
    expect(readCachedSession(stateDir)).toBeNull();
    expect(resolveSessionPath(stateDir)).toBe(
      join(stateDir, "atomic-mail", "session.json"),
    );
  });
});
