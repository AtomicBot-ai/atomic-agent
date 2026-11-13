import { describe, expect, it, vi } from "vitest";

import { ensureComposioSession } from "./ensure-composio-session.js";
import type { ComposioSession } from "./composio-api.js";

const FRESH: ComposioSession = {
  sessionId: "trs_new",
  mcpUrl: "https://backend.composio.dev/tool_router/trs_new/mcp",
  toolNames: ["COMPOSIO_SEARCH_TOOLS"],
};

const EMPTY_CACHE = { userId: null, sessionId: null, mcpUrl: null };

describe("ensureComposioSession", () => {
  it("reuses a cached session without calling the API", async () => {
    const createSession = vi.fn();
    const persist = vi.fn();
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "user-1",
        sessionId: "trs_cached",
        mcpUrl: "https://example.test/mcp",
      },
      persist,
      createSession,
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      sessionId: "trs_cached",
      mcpUrl: "https://example.test/mcp",
      userId: "user-1",
      created: false,
    });
  });

  it("mints a UUID user id on first use and persists it", async () => {
    const createSession = vi.fn(async () => FRESH);
    const persist = vi.fn();
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: EMPTY_CACHE,
      persist,
      createSession,
    });
    expect(out.created).toBe(true);
    expect(out.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "ak", userId: out.userId }),
    );
    expect(persist).toHaveBeenCalledWith({
      userId: out.userId,
      sessionId: "trs_new",
      mcpUrl: FRESH.mcpUrl,
      sessionPins: null,
    });
  });

  it("keeps an existing user id when only the session is missing", async () => {
    // Connected accounts hang off the user id — regenerating it would
    // silently orphan every app the operator has already authorised.
    const createSession = vi.fn(async () => FRESH);
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: { userId: "user-keep", sessionId: null, mcpUrl: null },
      persist: vi.fn(),
      createSession,
    });
    expect(out.userId).toBe("user-keep");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-keep" }),
    );
  });

  it("re-creates the session when forceRefresh is set", async () => {
    const createSession = vi.fn(async () => FRESH);
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "user-1",
        sessionId: "trs_stale",
        mcpUrl: "https://example.test/mcp",
      },
      persist: vi.fn(),
      forceRefresh: true,
      createSession,
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(out.sessionId).toBe("trs_new");
    expect(out.userId).toBe("user-1");
  });

  it("treats a half-written cache as a miss", async () => {
    // A sessionId with no url (or vice versa) cannot be mounted; minting
    // a fresh session beats booting with an unusable transport.
    const createSession = vi.fn(async () => FRESH);
    await ensureComposioSession({
      apiKey: "ak",
      cache: { userId: "u", sessionId: "trs_x", mcpUrl: null },
      persist: vi.fn(),
      createSession,
    });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("treats blank cached strings as absent", async () => {
    const createSession = vi.fn(async () => FRESH);
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: { userId: "   ", sessionId: "  ", mcpUrl: "  " },
      persist: vi.fn(),
      createSession,
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(out.userId).not.toBe("   ");
  });

  it("reuses a pinned session whose stamp matches the current pins", async () => {
    const createSession = vi.fn();
    const out = await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "u",
        sessionId: "trs_pinned",
        mcpUrl: "https://example.test/mcp",
        sessionPins: "trs_pinned#gmail=ca_work",
      },
      connectedAccounts: { gmail: ["ca_work"] },
      persist: vi.fn(),
      createSession,
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(out.created).toBe(false);
  });

  it("creates a new session when the default account changed", async () => {
    const createSession = vi.fn(async () => FRESH);
    const persist = vi.fn();
    await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "u",
        sessionId: "trs_pinned",
        mcpUrl: "https://example.test/mcp",
        sessionPins: "trs_pinned#gmail=ca_work",
      },
      connectedAccounts: { gmail: ["ca_home"] },
      persist,
      createSession,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ connectedAccounts: { gmail: ["ca_home"] } }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPins: "trs_new#gmail=ca_home" }),
    );
  });

  it("does not trust a stamp left over from a different session id", async () => {
    // Another writer (an older build, the desktop key check) swapped the
    // session id but kept the stamp: that session was made unpinned.
    const createSession = vi.fn(async () => FRESH);
    await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "u",
        sessionId: "trs_other",
        mcpUrl: "https://example.test/mcp",
        sessionPins: "trs_pinned#gmail=ca_work",
      },
      connectedAccounts: { gmail: ["ca_work"] },
      persist: vi.fn(),
      createSession,
    });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("drops a pinned session once every default is cleared", async () => {
    const createSession = vi.fn(async () => FRESH);
    const persist = vi.fn();
    await ensureComposioSession({
      apiKey: "ak",
      cache: {
        userId: "u",
        sessionId: "trs_pinned",
        mcpUrl: "https://example.test/mcp",
        sessionPins: "trs_pinned#gmail=ca_work",
      },
      connectedAccounts: {},
      persist,
      createSession,
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ connectedAccounts: expect.anything() }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPins: null }),
    );
  });
});
