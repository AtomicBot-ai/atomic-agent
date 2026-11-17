import { afterEach, describe, expect, it } from "vitest";

import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import type { HttpRole } from "./http-scopes.js";
import { hashHttpToken, type StoredHttpToken } from "./http-token-store.js";
import { sendJson } from "./request-context.js";
import { identifyCaller } from "./scoped-auth.js";

/**
 * ATO-583: the 401 / 403 matrix on a real server with stub routes. The
 * runtime is never touched by these handlers.
 */
const KEY = "k".repeat(32);
const TOKENS: Record<HttpRole, string> = {
  admin: "atag_admin-token-0000000000000000",
  member: "atag_member-token-000000000000000",
  viewer: "atag_viewer-token-000000000000000",
};

function stored(role: HttpRole): StoredHttpToken {
  return { name: `${role}-laptop`, role, sha256: hashHttpToken(TOKENS[role]), createdAt: "2026-11-18T00:00:00.000Z" };
}

const ok = (_req: unknown, res: Parameters<RouteDefinition["handler"]>[1]): void => sendJson(res, 200, { ok: true });
const ROUTES: RouteDefinition[] = [
  { method: "GET", path: "/open", handler: ok, requiresAuth: false },
  { method: "GET", path: "/read", handler: ok, scope: "read" },
  { method: "POST", path: "/chat", handler: ok, scope: "chat" },
  { method: "POST", path: "/admin", handler: ok, scope: "admin" },
  // Not in ROUTE_SCOPES and not tagged: needs admin.
  { method: "POST", path: "/untagged", handler: ok },
];

const servers: HttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(apiKey: string | null, named: StoredHttpToken[]): Promise<string> {
  const handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey,
    routes: ROUTES,
    namedTokens: () => named,
  });
  servers.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

async function call(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string | null; message: string }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (method !== "GET") {
    init.body = "{}";
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`${base}${path}`, init);
  const body = (await res.json()) as { error?: { code: string | null; message: string } };
  return { status: res.status, code: body.error?.code ?? null, message: body.error?.message ?? "" };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ALL = [stored("admin"), stored("member"), stored("viewer")];

describe("scoped auth: roles against route scopes", () => {
  const matrix: Array<[HttpRole | "key", string, string, number]> = [
    ["key", "GET", "/read", 200],
    ["key", "POST", "/chat", 200],
    ["key", "POST", "/admin", 200],
    ["key", "POST", "/untagged", 200],
    ["admin", "GET", "/read", 200],
    ["admin", "POST", "/chat", 200],
    ["admin", "POST", "/admin", 200],
    ["admin", "POST", "/untagged", 200],
    ["member", "GET", "/read", 200],
    ["member", "POST", "/chat", 200],
    ["member", "POST", "/admin", 403],
    ["member", "POST", "/untagged", 403],
    ["viewer", "GET", "/read", 200],
    ["viewer", "POST", "/chat", 403],
    ["viewer", "POST", "/admin", 403],
    ["viewer", "POST", "/untagged", 403],
  ];

  it.each(matrix)("%s on %s %s answers %i", async (who, method, path, status) => {
    const base = await start(KEY, ALL);
    const token = who === "key" ? KEY : TOKENS[who];
    expect((await call(base, method, path, bearer(token))).status).toBe(status);
  });

  it("a 403 names the token, its role, the route and the scope it lacks", async () => {
    const base = await start(KEY, ALL);
    const out = await call(base, "POST", "/admin", bearer(TOKENS.viewer));
    expect(out.status).toBe(403);
    expect(out.code).toBe("insufficient_scope");
    expect(out.message).toBe(
      'Token "viewer-laptop" has the viewer role and cannot use POST /admin: it needs the admin scope',
    );
  });

  it("an unknown or missing token is 401, never 403", async () => {
    const base = await start(KEY, ALL);
    expect(await call(base, "GET", "/read", bearer("atag_nope"))).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect(await call(base, "GET", "/read")).toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it("accepts a named token as x-api-key, like the serve key", async () => {
    const base = await start(KEY, ALL);
    expect((await call(base, "POST", "/chat", { "x-api-key": TOKENS.member })).status).toBe(200);
    expect((await call(base, "POST", "/admin", { "x-api-key": TOKENS.member })).status).toBe(403);
  });

  it("an open route stays open with named tokens on", async () => {
    const base = await start(KEY, ALL);
    expect((await call(base, "GET", "/open")).status).toBe(200);
  });

  it("a removed token stops working on the next request", async () => {
    const named = [...ALL];
    const handle = await createHttpServer({
      runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: KEY, routes: ROUTES, namedTokens: () => named,
    });
    servers.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await call(base, "GET", "/read", bearer(TOKENS.viewer))).status).toBe(200);
    named.splice(named.findIndex((t) => t.role === "viewer"), 1);
    expect((await call(base, "GET", "/read", bearer(TOKENS.viewer))).status).toBe(401);
  });
});

describe("scoped auth: backward compatibility", () => {
  it("one key and no named tokens: the key opens every route, anything else is 401", async () => {
    const base = await start(KEY, []);
    for (const [method, path] of [["GET", "/read"], ["POST", "/chat"], ["POST", "/admin"], ["POST", "/untagged"]] as const) {
      expect((await call(base, method, path, bearer(KEY))).status).toBe(200);
      expect((await call(base, method, path, bearer(TOKENS.admin))).status).toBe(401);
      expect((await call(base, method, path)).status).toBe(401);
    }
  });

  it("no key and no named tokens: every route is open, as before", async () => {
    const base = await start(null, []);
    expect((await call(base, "POST", "/admin")).status).toBe(200);
    expect((await call(base, "POST", "/admin", bearer("anything"))).status).toBe(200);
  });

  it("no key with named tokens on disk: still open; a viewer token narrows nothing", async () => {
    const base = await start(null, ALL);
    expect((await call(base, "POST", "/admin")).status).toBe(200);
    expect((await call(base, "POST", "/admin", bearer(TOKENS.viewer))).status).toBe(200);
  });

  it("no namedTokens option at all behaves like an empty list", async () => {
    const handle = await createHttpServer({ runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: KEY, routes: ROUTES });
    servers.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await call(base, "POST", "/admin", bearer(KEY))).status).toBe(200);
    expect((await call(base, "POST", "/admin", bearer(TOKENS.admin))).status).toBe(401);
  });
});

describe("identifyCaller", () => {
  it("the serve key is always admin", () => {
    expect(identifyCaller(KEY, KEY, ALL)).toEqual({ name: "api-key", role: "admin" });
  });

  it("finds a named token by its hash and refuses empty or unknown values", () => {
    expect(identifyCaller(TOKENS.member, KEY, ALL)).toEqual({ name: "member-laptop", role: "member" });
    expect(identifyCaller("", KEY, ALL)).toBeNull();
    expect(identifyCaller(null, KEY, ALL)).toBeNull();
    expect(identifyCaller(hashHttpToken(TOKENS.member), KEY, ALL)).toBeNull();
  });
});
