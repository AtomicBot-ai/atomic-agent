import { describe, expect, it, vi } from "vitest";

import { TeamsApi, TeamsApiError } from "./msteams-api.js";

const SERVICE = "https://smba.invalid/emea";

function fakeFetch(handlers: { token?: () => Response; activity?: (url: string, init: RequestInit) => Response } = {}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).includes("login.microsoftonline.com")) {
      return handlers.token?.() ?? new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }));
    }
    return handlers.activity?.(String(url), init) ?? new Response(JSON.stringify({ id: "act-9" }));
  });
}

function api(fetchImpl: ReturnType<typeof fakeFetch>, over: Partial<ConstructorParameters<typeof TeamsApi>[0]> = {}) {
  return new TeamsApi({
    appId: "app",
    appPassword: "secret-value",
    tenantId: null,
    isAllowedServiceUrl: (u) => u === SERVICE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
    ...over,
  });
}

describe("TeamsApi", () => {
  it("gets a client-credentials token for the Bot Framework scope and caches it", async () => {
    const f = fakeFetch();
    const a = api(f);
    expect(await a.getToken()).toBe("tok-1");
    expect(await a.getToken()).toBe("tok-1");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token");
    expect(String(init.body)).toContain("scope=https%3A%2F%2Fapi.botframework.com%2F.default");
    expect(String(init.body)).toContain("grant_type=client_credentials");
  });

  it("uses the configured tenant for a single-tenant app", async () => {
    const f = fakeFetch();
    await api(f, { tenantId: "contoso.onmicrosoft.com" }).getToken();
    expect(f.mock.calls[0]?.[0]).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
  });

  it("surfaces a refused credential as token_<error>", async () => {
    const f = fakeFetch({ token: () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }) });
    await expect(api(f).getToken()).rejects.toMatchObject({ code: "token_invalid_client" });
  });

  it("replies to an activity under the conversation, with the bearer token", async () => {
    const f = fakeFetch();
    const id = await api(f).sendActivity(
      { serviceUrl: `${SERVICE}/`, conversationId: "19:abc@thread.tacv2;messageid=1", replyToId: "1" },
      { type: "message", text: "hi" },
    );
    expect(id).toBe("act-9");
    const [url, init] = f.mock.calls[1]!;
    expect(url).toBe(`${SERVICE}/v3/conversations/${encodeURIComponent("19:abc@thread.tacv2;messageid=1")}/activities/1`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("never sends the token to a service URL no authenticated activity came from", async () => {
    const f = fakeFetch();
    await expect(
      api(f).sendActivity({ serviceUrl: "https://evil.example", conversationId: "c" }, { type: "message" }),
    ).rejects.toBeInstanceOf(TeamsApiError);
    expect(f).not.toHaveBeenCalled();
  });

  it("refetches the token once on a 401 from the connector", async () => {
    let calls = 0;
    const f = fakeFetch({
      activity: () => (++calls === 1 ? new Response("", { status: 401 }) : new Response(JSON.stringify({ id: "x" }))),
    });
    await api(f).sendActivity({ serviceUrl: SERVICE, conversationId: "c" }, { type: "message" });
    expect(f.mock.calls.filter(([u]) => String(u).includes("login.microsoftonline.com"))).toHaveLength(2);
  });

  it("splits long text into 4000-character messages", async () => {
    const f = fakeFetch();
    await api(f).postText({ serviceUrl: SERVICE, conversationId: "c" }, "x ".repeat(3000));
    const sends = f.mock.calls.filter(([u]) => String(u).includes("/activities"));
    expect(sends).toHaveLength(2);
    for (const [, init] of sends) {
      expect((JSON.parse(String(init.body)) as { text: string }).text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("updates an activity with PUT", async () => {
    const f = fakeFetch();
    await api(f).updateActivity({ serviceUrl: SERVICE, conversationId: "c" }, "act-1", { type: "message" });
    const [url, init] = f.mock.calls[1]!;
    expect(url).toBe(`${SERVICE}/v3/conversations/c/activities/act-1`);
    expect(init.method).toBe("PUT");
  });
});
