import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { msteamsChannelDefinition, readTeamsPort, readTeamsTenantId } from "./index.js";
import { TeamsChannel, type TeamsChannelDeps } from "./msteams-channel.js";
import type { TeamsServerDeps } from "./msteams-server.js";

const SERVICE = "https://smba.invalid/emea/";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function teamsFetch(token: () => Response = () => new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))) {
  return vi.fn(async (url: string) =>
    String(url).includes("login.microsoftonline.com") ? token() : new Response(JSON.stringify({ id: "act-1" })),
  );
}

function makeChannel(over: Partial<TeamsChannelDeps> = {}, listen: () => Promise<void> = async () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), "atomic-msteams-"));
  dirs.push(dir);
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn() };
  const endpoints: Array<{ deps: TeamsServerDeps; listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "pong" } });
    return {};
  });
  const fetchImpl = teamsFetch();
  const channel = new TeamsChannel({
    runtime: { runTurn, createSession: () => ({ id: "s1" }), sessionStore: { load: () => null } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerIds: ["aad-owner"],
    port: 3978,
    tenantId: null,
    sessionMapPath: join(dir, "msteams-session.json"),
    lock,
    appId: "app-id",
    appPassword: "super-secret-password",
    onStatus: (s) => statuses.push(s),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createEndpoint: (deps) => {
      const e = { deps, listen: vi.fn(listen), close: vi.fn(async () => undefined) };
      endpoints.push(e);
      return e;
    },
    ...over,
  });
  return { channel, statuses, lock, endpoints, runTurn, fetchImpl };
}

describe("TeamsChannel", () => {
  it("stays disabled without the App ID or password, or when switched off", async () => {
    for (const over of [{ appId: null }, { appPassword: null }, { enabled: false }]) {
      const { channel, lock, endpoints } = makeChannel(over);
      await channel.start();
      expect(channel.state()).toBe("disabled");
      expect(lock.acquire).not.toHaveBeenCalled();
      expect(endpoints).toHaveLength(0);
    }
  });

  it("is up once the endpoint listens", async () => {
    const { channel, statuses, lock, endpoints } = makeChannel();
    await channel.start();
    expect(channel.state()).toBe("up");
    expect(lock.acquire).toHaveBeenCalledTimes(1);
    expect(endpoints[0]?.deps.port).toBe(3978);
    expect(statuses.map((s) => s.state)).toEqual(["starting", "up"]);
  });

  it("goes down without leaking the secret when Microsoft rejects the credentials", async () => {
    const fetchImpl = teamsFetch(() => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    const { channel, lock } = makeChannel({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/invalid_client/);
    expect(channel.lastError()).not.toContain("super-secret-password");
    expect(lock.release).toHaveBeenCalled();
  });

  it("reports a busy port and retries on an unref'd timer", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { channel } = makeChannel({}, async () => {
        if (++calls === 1) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      });
      await channel.start();
      expect(channel.state()).toBe("down");
      expect(channel.lastError()).toMatch(/3978/);
      await vi.advanceTimersByTimeAsync(70_000);
      expect(channel.state()).toBe("up");
      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs an authenticated activity and replies to its service URL", async () => {
    const { channel, endpoints, runTurn, fetchImpl } = makeChannel();
    await channel.start();
    endpoints[0]!.deps.onActivity({
      type: "message",
      id: "m1",
      channelId: "msteams",
      serviceUrl: SERVICE,
      text: "ping",
      from: { id: "29:u", aadObjectId: "aad-owner" },
      recipient: { id: "28:bot" },
      conversation: { id: "a:1", conversationType: "personal" },
    });
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("/v3/conversations/a%3A1/activities"))).toBe(true));
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("stop() closes the endpoint, releases the lock and is idempotent", async () => {
    const { channel, lock, endpoints } = makeChannel();
    await channel.start();
    await channel.stop();
    await channel.stop();
    expect(endpoints[0]?.close).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(channel.state()).toBe("disabled");
  });
});

describe("msteamsChannelDefinition", () => {
  it("registers as msteams and reads port and tenant from options", () => {
    expect(msteamsChannelDefinition.id).toBe("msteams");
    expect(readTeamsPort({ port: 4000 })).toBe(4000);
    expect(readTeamsPort({ port: "nope" })).toBe(3978);
    expect(readTeamsPort({})).toBe(3978);
    expect(readTeamsTenantId({ tenantId: "contoso.onmicrosoft.com" })).toBe("contoso.onmicrosoft.com");
    expect(readTeamsTenantId({})).toBeNull();
  });
});
