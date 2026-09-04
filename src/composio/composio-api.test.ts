import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSIO_API_KEY_HEADER,
  ComposioApiError,
  createComposioSession,
  parseSessionResponse,
} from "./composio-api.js";

/** Shape of a real 201 body, trimmed to the fields we read. */
const OK_BODY = {
  session_id: "trs_abc123",
  mcp: {
    type: "http",
    url: "https://backend.composio.dev/tool_router/trs_abc123/mcp",
  },
  tool_router_tools: [
    "COMPOSIO_SEARCH_TOOLS",
    "COMPOSIO_GET_TOOL_SCHEMAS",
    "COMPOSIO_MANAGE_CONNECTIONS",
    "COMPOSIO_MULTI_EXECUTE_TOOL",
  ],
  experimental: { assistive_prompt: "use the meta-tools" },
};

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSessionResponse", () => {
  it("reads the session id, mcp url, tool names and assistive prompt", () => {
    const session = parseSessionResponse(OK_BODY);
    expect(session.sessionId).toBe("trs_abc123");
    expect(session.mcpUrl).toBe(
      "https://backend.composio.dev/tool_router/trs_abc123/mcp",
    );
    expect(session.toolNames).toHaveLength(4);
    expect(session.assistivePrompt).toBe("use the meta-tools");
  });

  it("omits the assistive prompt when the API does not send one", () => {
    const { experimental: _drop, ...rest } = OK_BODY;
    expect(parseSessionResponse(rest).assistivePrompt).toBeUndefined();
  });

  it("rejects a body with no session id", () => {
    expect(() => parseSessionResponse({ mcp: { url: "x" } })).toThrow(
      ComposioApiError,
    );
  });

  it("rejects a body with no mcp url", () => {
    expect(() => parseSessionResponse({ session_id: "trs_x" })).toThrow(
      ComposioApiError,
    );
  });

  it("rejects a non-object body", () => {
    expect(() => parseSessionResponse("nope")).toThrow(ComposioApiError);
  });
});

describe("createComposioSession", () => {
  it("posts the user id, disables the workbench, and sends x-api-key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createComposioSession({
      apiKey: "ak_test",
      userId: "11111111-2222-3333-4444-555555555555",
      baseUrl: "https://example.test/api/v3.1",
    });

    expect(session.sessionId).toBe("trs_abc123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/api/v3.1/tool_router/session");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)[COMPOSIO_API_KEY_HEADER],
    ).toBe("ak_test");
    // The remote workbench duplicates os.shell.run and would route the
    // operator's shell work through a third party — it stays off.
    expect(JSON.parse(init.body as string)).toEqual({
      user_id: "11111111-2222-3333-4444-555555555555",
      workbench: { enable: false },
    });
  });

  it("reports a rejected key distinctly from other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)));
    await expect(
      createComposioSession({ apiKey: "bad", userId: "u" }),
    ).rejects.toMatchObject({ name: "ComposioApiError", status: 401 });
    await expect(
      createComposioSession({ apiKey: "bad", userId: "u" }),
    ).rejects.toThrow(/rejected the API key/);
  });

  it("surfaces a server-side failure with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));
    await expect(
      createComposioSession({ apiKey: "ak", userId: "u" }),
    ).rejects.toMatchObject({ name: "ComposioApiError", status: 503 });
  });

  it("translates a transport failure into a ComposioApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      createComposioSession({ apiKey: "ak", userId: "u" }),
    ).rejects.toThrow(/Could not reach Composio/);
  });

  it("lets a caller-side abort through untranslated", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("The operation was aborted");
      }),
    );
    await expect(
      createComposioSession({
        apiKey: "ak",
        userId: "u",
        signal: controller.signal,
      }),
    ).rejects.not.toBeInstanceOf(ComposioApiError);
  });
});
