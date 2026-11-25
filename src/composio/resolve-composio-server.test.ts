import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComposioServerConfig } from "./resolve-composio-server.js";
import type { ComposioConfig } from "../config/config-schema.js";

// The gate must be decidable without touching <stateDir>/config.json.
const persistMock = vi.hoisted(() => vi.fn());
vi.mock("./persist-composio-session.js", () => ({
  persistComposioSession: persistMock,
  clearComposioSession: vi.fn(),
}));

const CACHED: ComposioConfig = {
  enabled: true,
  apiKeyEnv: "COMPOSIO_API_KEY",
  userId: "user-1",
  sessionId: "trs_cached",
  mcpUrl: "https://backend.composio.dev/tool_router/trs_cached/mcp",
  accounts: [],
  sessionPins: null,
};

function logger() {
  return { warn: vi.fn(), info: vi.fn() };
}

beforeEach(() => {
  persistMock.mockClear();
  vi.unstubAllGlobals();
});

describe("resolveComposioServerConfig", () => {
  it("mounts nothing when no key is configured", async () => {
    // This is the whole product requirement: with no key there is no
    // server, so no Composio tool is ever registered and the model
    // cannot reach one.
    await expect(
      resolveComposioServerConfig({
        composio: CACHED,
        userConfigFile: "/nonexistent/config.json",
        env: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("mounts nothing when the key is present but the block is disabled", async () => {
    await expect(
      resolveComposioServerConfig({
        composio: { ...CACHED, enabled: false },
        userConfigFile: "/nonexistent/config.json",
        env: { COMPOSIO_API_KEY: "ak_live" },
      }),
    ).resolves.toBeUndefined();
  });

  it("mounts the cached session when a key is present", async () => {
    const cfg = await resolveComposioServerConfig({
      composio: CACHED,
      userConfigFile: "/nonexistent/config.json",
      env: { COMPOSIO_API_KEY: "ak_live" },
    });
    expect(cfg?.name).toBe("composio");
    expect(cfg?.transport).toMatchObject({
      kind: "streamable_http",
      url: CACHED.mcpUrl,
      headers: { "x-api-key": "ak_live" },
    });
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("degrades to no server, not a boot failure, when Composio is down", async () => {
    // A third-party SaaS broker being unreachable has nothing to do with
    // the operator's shell, files or browser — the agent must still boot.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const log = logger();
    await expect(
      resolveComposioServerConfig({
        composio: { ...CACHED, sessionId: null, mcpUrl: null },
        userConfigFile: "/nonexistent/config.json",
        env: { COMPOSIO_API_KEY: "ak_live" },
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "composio unavailable; continuing without it",
      expect.objectContaining({
        error: expect.stringContaining("ECONNREFUSED"),
      }),
    );
  });

  it("degrades to no server when the key is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const log = logger();
    await expect(
      resolveComposioServerConfig({
        composio: { ...CACHED, sessionId: null, mcpUrl: null },
        userConfigFile: "/nonexistent/config.json",
        env: { COMPOSIO_API_KEY: "ak_bad" },
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("creates and persists a session when the cache is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session_id: "trs_new",
              mcp: { url: "https://example.test/tool_router/trs_new/mcp" },
              tool_router_tools: ["COMPOSIO_SEARCH_TOOLS"],
            }),
            { status: 201 },
          ),
      ),
    );
    const log = logger();
    const cfg = await resolveComposioServerConfig({
      composio: { ...CACHED, sessionId: null, mcpUrl: null },
      userConfigFile: "/tmp/config.json",
      env: { COMPOSIO_API_KEY: "ak_live" },
      logger: log,
    });
    expect(cfg?.transport).toMatchObject({
      url: "https://example.test/tool_router/trs_new/mcp",
    });
    expect(persistMock).toHaveBeenCalledWith("/tmp/config.json", {
      userId: "user-1",
      sessionId: "trs_new",
      mcpUrl: "https://example.test/tool_router/trs_new/mcp",
      sessionPins: null,
    });
    expect(log.info).toHaveBeenCalled();
  });

  it("pins default accounts and replaces a cached session made without them", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            session_id: "trs_pinned",
            mcp: { url: "https://example.test/tool_router/trs_pinned/mcp" },
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cfg = await resolveComposioServerConfig({
      composio: {
        ...CACHED,
        accounts: [
          { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: false },
          { toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: true },
        ],
      },
      userConfigFile: "/tmp/config.json",
      env: { COMPOSIO_API_KEY: "ak_live" },
    });
    // The cached trs_cached session carries no pins, so it is not reused.
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).connected_accounts).toEqual({
      gmail: ["ca_work"],
    });
    expect(cfg?.transport).toMatchObject({
      url: "https://example.test/tool_router/trs_pinned/mcp",
    });
    expect(persistMock).toHaveBeenCalledWith(
      "/tmp/config.json",
      expect.objectContaining({
        sessionId: "trs_pinned",
        sessionPins: "trs_pinned#gmail=ca_work",
      }),
    );
  });

  it("keeps the cached session when named accounts exist but none is default", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cfg = await resolveComposioServerConfig({
      composio: {
        ...CACHED,
        accounts: [
          { toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: false },
        ],
      },
      userConfigFile: "/tmp/config.json",
      env: { COMPOSIO_API_KEY: "ak_live" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cfg?.transport).toMatchObject({ url: CACHED.mcpUrl });
  });
});
