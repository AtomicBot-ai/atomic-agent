import { describe, expect, it } from "vitest";

import {
  HTTP_SCOPES,
  ROLE_SCOPES,
  ROUTE_SCOPES,
  roleHasScope,
  routeKey,
  scopeForRoute,
} from "./http-scopes.js";
import { buildRouteTable } from "./route-table.js";
import { buildTunnelRouteTable } from "./tunnel-route-table.js";

/** ATO-583: the route -> scope table is pinned to the real route table. */
describe("ROUTE_SCOPES", () => {
  const routes = buildRouteTable();
  const authed = routes.filter((r) => r.requiresAuth !== false).map((r) => routeKey(r.method, r.path));
  const open = routes.filter((r) => r.requiresAuth === false).map((r) => routeKey(r.method, r.path));

  it("names a scope for every authenticated route (add one for a new route)", () => {
    const missing = authed.filter((key) => !(key in ROUTE_SCOPES));
    expect(missing).toEqual([]);
  });

  it("has no entry for a route that no longer exists, or for an open route", () => {
    const known = new Set(authed);
    const stale = Object.keys(ROUTE_SCOPES).filter((key) => !known.has(key));
    expect(stale).toEqual([]);
    for (const key of open) expect(ROUTE_SCOPES[key]).toBeUndefined();
  });

  it("uses only known scopes", () => {
    for (const scope of Object.values(ROUTE_SCOPES)) expect(HTTP_SCOPES).toContain(scope);
  });

  it("keeps the pre-auth probes open: /health, /v1/models and the panel shell", () => {
    expect(open).toEqual(
      expect.arrayContaining(["GET /health", "GET /v1/models", "GET /panel", "GET /panel/app.js"]),
    );
  });

  it("puts config, skills and webhook admin behind admin, and chat behind chat", () => {
    expect(scopeForRoute("GET", "/api/config")).toBe("admin");
    expect(scopeForRoute("put", "/api/config")).toBe("admin");
    expect(scopeForRoute("POST", "/api/skills/install")).toBe("admin");
    expect(scopeForRoute("POST", "/api/webhooks")).toBe("admin");
    expect(scopeForRoute("POST", "/v1/chat/completions")).toBe("chat");
    expect(scopeForRoute("GET", "/api/sessions")).toBe("read");
  });

  it("asks admin for a route the table does not know", () => {
    expect(scopeForRoute("POST", "/api/not-a-route")).toBe("admin");
  });

  it("leaves the tunnel gateway unauthenticated, so scopes never apply there", () => {
    for (const route of buildTunnelRouteTable()) expect(route.requiresAuth).toBe(false);
  });
});

describe("ROLE_SCOPES", () => {
  it("admin has every scope, member read + chat, viewer read", () => {
    expect([...ROLE_SCOPES.admin].sort()).toEqual([...HTTP_SCOPES].sort());
    expect(ROLE_SCOPES.member).toEqual(["read", "chat"]);
    expect(ROLE_SCOPES.viewer).toEqual(["read"]);
    expect(roleHasScope("member", "admin")).toBe(false);
    expect(roleHasScope("viewer", "chat")).toBe(false);
  });
});
