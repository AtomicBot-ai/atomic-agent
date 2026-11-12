import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listComposioConnectedAccounts,
  parseConnectedAccountsPage,
} from "./composio-accounts-api.js";
import { COMPOSIO_API_KEY_HEADER, ComposioApiError } from "./composio-api.js";

/** A listing item trimmed to what the agent reads, plus noise it ignores. */
function item(id: string, toolkit: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    toolkit: { slug: toolkit },
    auth_config: { id: "ac_1", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
    status: "ACTIVE",
    alias: null,
    word_id: `${toolkit}_red-castle`,
    created_at: "2026-11-01T10:00:00Z",
    state: { authScheme: "OAUTH2", val: { status: "ACTIVE", displayName: `${id}@example.com` } },
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseConnectedAccountsPage", () => {
  it("keeps id, toolkit, status, alias, display name and creation time", () => {
    const page = parseConnectedAccountsPage({
      items: [item("ca_work", "GMAIL", { alias: "work-gmail" })],
      next_cursor: null,
    });
    expect(page).toEqual({
      items: [
        {
          id: "ca_work",
          toolkit: "gmail",
          status: "ACTIVE",
          alias: "work-gmail",
          displayName: "ca_work@example.com",
          createdAt: "2026-11-01T10:00:00Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("skips malformed items rather than failing the whole page", () => {
    const page = parseConnectedAccountsPage({
      items: [{ id: "ca_x" }, "junk", item("ca_ok", "github")],
      next_cursor: "",
    });
    expect(page.items.map((a) => a.id)).toEqual(["ca_ok"]);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a body without items", () => {
    expect(() => parseConnectedAccountsPage({})).toThrow(ComposioApiError);
    expect(() => parseConnectedAccountsPage(null)).toThrow(ComposioApiError);
  });
});

describe("listComposioConnectedAccounts", () => {
  it("asks for the user's active accounts with the API key header", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [item("ca_work", "gmail")], next_cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await listComposioConnectedAccounts({
      apiKey: "ak_test",
      userId: "user-1",
      toolkit: "gmail",
      baseUrl: "https://example.test/api/v3.1",
    });

    expect(out.map((a) => a.id)).toEqual(["ca_work"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://example.test/api/v3.1/connected_accounts",
    );
    expect(parsed.searchParams.getAll("user_ids")).toEqual(["user-1"]);
    expect(parsed.searchParams.getAll("toolkit_slugs")).toEqual(["gmail"]);
    expect(parsed.searchParams.getAll("statuses")).toEqual(["ACTIVE"]);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)[COMPOSIO_API_KEY_HEADER]).toBe("ak_test");
  });

  it("follows the cursor across pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [item("ca_1", "gmail")], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse({ items: [item("ca_2", "gmail")], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await listComposioConnectedAccounts({ apiKey: "ak", userId: "u" });

    expect(out.map((a) => a.id)).toEqual(["ca_1", "ca_2"]);
    const second = new URL((fetchMock.mock.calls[1] as [string])[0]);
    expect(second.searchParams.get("cursor")).toBe("c2");
    expect(second.searchParams.has("toolkit_slugs")).toBe(false);
  });

  it("stops after a bounded number of pages if the cursor never ends", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], next_cursor: "again" }));
    vi.stubGlobal("fetch", fetchMock);
    await listComposioConnectedAccounts({ apiKey: "ak", userId: "u" });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("can ask for every status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await listComposioConnectedAccounts({ apiKey: "ak", userId: "u", statuses: [] });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.has("statuses")).toBe(false);
  });

  it("reports a rejected key like the session call does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)));
    await expect(
      listComposioConnectedAccounts({ apiKey: "bad", userId: "u" }),
    ).rejects.toMatchObject({ name: "ComposioApiError", status: 401 });
  });
});
