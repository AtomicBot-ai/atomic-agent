import { describe, expect, it } from "vitest";

import { parseAddServerJson } from "../config/mcp-server-commands.js";
import { buildMcpCatalogJson, findMcpCatalogEntry } from "../mcp/mcp-catalog.js";
import type { IntegrationStatusContext } from "./integration-descriptor.js";
import { findIntegration, listIntegrations } from "./integration-registry.js";
import {
  MONID_DISCONNECT_ACTION,
  MONID_SIGNIN_ACTION,
  findMonidServer,
  monidAddServerJson,
  monidHasSignIn,
  monidIntegration,
  monidServerUrl,
  monidStatus,
} from "./monid-integration.js";

const CATALOG_SERVER = {
  name: "monid",
  enabled: true,
  transport: { kind: "streamable_http", url: "https://mcp.monid.ai/v1" },
};

function ctx(over: Partial<IntegrationStatusContext> & { servers?: unknown[] } = {}): IntegrationStatusContext {
  const { servers, ...rest } = over;
  return {
    presentFields: new Set(),
    configured: false,
    config: { mcp: { servers: servers ?? [] } },
    ...rest,
  };
}

describe("Monid integration (ATO-1630)", () => {
  it("sits in the hub right after Composio", () => {
    const ids = listIntegrations().map((i) => i.id);
    expect(ids.indexOf("monid")).toBe(ids.indexOf("composio") + 1);
    expect(findIntegration("monid")).toBe(monidIntegration);
  });

  it("asks for no key: no fields, a sign-in verb and a disconnect verb", () => {
    expect(monidIntegration.fields).toEqual([]);
    expect(monidIntegration.actions?.map(({ key, id, label }) => ({ key, id, label }))).toEqual([
      { key: "s", id: MONID_SIGNIN_ACTION, label: "sign in with Monid" },
      { key: "x", id: MONID_DISCONNECT_ACTION, label: "disconnect" },
    ]);
    // The verb must not shadow the detail view's built-in keys.
    for (const a of monidIntegration.actions ?? []) {
      expect(["e", "d"]).not.toContain(a.key);
    }
    expect(monidIntegration.appliesLive).toBe(true);
    for (const step of monidIntegration.setupSteps ?? []) {
      expect(step.length).toBeGreaterThan(0);
      expect(step.length).toBeLessThanOrEqual(100);
    }
    expect(JSON.stringify(monidIntegration)).not.toMatch(/api key field|MONID_API_KEY/i);
  });

  it("adds exactly the server the MCP catalog card adds", () => {
    const card = findMcpCatalogEntry("monid");
    expect(card).toBeDefined();
    expect(card?.auth).toBe("oauth");
    expect(monidAddServerJson()).toBe(buildMcpCatalogJson(card!));
    expect(monidServerUrl()).toBe("https://mcp.monid.ai/v1");
    const server = parseAddServerJson(monidAddServerJson());
    expect(server.name).toBe("monid");
    expect(server.transport).toEqual({ kind: "streamable_http", url: "https://mcp.monid.ai/v1" });
  });

  describe("no duplicate with the catalog card", () => {
    it("finds nothing when no Monid server is configured", () => {
      expect(findMonidServer(undefined)).toBeUndefined();
      expect(findMonidServer([])).toBeUndefined();
      expect(
        findMonidServer([{ name: "github", enabled: true, transport: { kind: "streamable_http", url: "https://api.githubcopilot.com/mcp/" } }]),
      ).toBeUndefined();
    });

    it("finds the server the catalog card added, so a second sign-in adds nothing", () => {
      const added = parseAddServerJson(monidAddServerJson());
      expect(findMonidServer([added])).toEqual({ name: "monid", url: "https://mcp.monid.ai/v1" });
      expect(findMonidServer([CATALOG_SERVER])).toEqual({ name: "monid", url: "https://mcp.monid.ai/v1" });
    });

    it("finds a server at Monid's URL whatever it is named, trailing slash and host case aside", () => {
      const renamed = {
        name: "my-monid",
        enabled: true,
        transport: { kind: "streamable_http", url: "https://MCP.monid.ai/v1/" },
      };
      expect(findMonidServer([renamed])).toEqual({ name: "my-monid", url: "https://MCP.monid.ai/v1/" });
    });

    it("prefers the server at Monid's URL over another one named monid", () => {
      const imposter = { name: "monid", enabled: true, transport: { kind: "stdio", command: "monid-local" } };
      const real = { name: "monid-cloud", enabled: true, transport: { kind: "sse", url: "https://mcp.monid.ai/v1" } };
      expect(findMonidServer([imposter, real])).toEqual({ name: "monid-cloud", url: "https://mcp.monid.ai/v1" });
      // Alone, the name still claims it: a second "monid" could not be added.
      expect(findMonidServer([imposter])).toEqual({ name: "monid", url: null });
    });

    it("ignores junk entries", () => {
      expect(findMonidServer([null, 3, "monid", { name: 7 }])).toBeUndefined();
    });
  });

  describe("status", () => {
    it("is not connected before any server exists", () => {
      const s = monidStatus(ctx());
      expect(s.level).toBe("not_configured");
      expect(s.detail).toMatch(/not signed in/);
    });

    it("is not connected when the server exists but has no saved sign-in", () => {
      expect(monidStatus(ctx({ servers: [CATALOG_SERVER] })).level).toBe("not_configured");
      expect(
        monidStatus(ctx({ servers: [CATALOG_SERVER], mcpServerStates: new Map([["monid", "needs_auth"]]) })).level,
      ).toBe("not_configured");
    });

    it("is signed in when a token is saved and the server is up", () => {
      const s = monidStatus(
        ctx({
          servers: [CATALOG_SERVER],
          mcpSignedIn: new Set(["monid"]),
          mcpServerStates: new Map([["monid", "up"]]),
        }),
      );
      expect(s).toEqual({ level: "connected", detail: "signed in" });
    });

    it("reads signed in, not connected, while the server is still connecting", () => {
      const s = monidStatus(ctx({ servers: [CATALOG_SERVER], mcpSignedIn: new Set(["monid"]) }));
      expect(s).toEqual({ level: "configured", detail: "signed in" });
    });

    it("says the sign-in expired when a token is saved but the server asks again", () => {
      const s = monidStatus(
        ctx({
          servers: [CATALOG_SERVER],
          mcpSignedIn: new Set(["monid"]),
          mcpServerStates: new Map([["monid", "needs_auth"]]),
        }),
      );
      expect(s.level).toBe("error");
      expect(s.detail).toMatch(/sign-in expired/);
    });

    it("reports a failed connection and a server turned off", () => {
      const signed = { servers: [CATALOG_SERVER], mcpSignedIn: new Set(["monid"]) };
      expect(monidStatus(ctx({ ...signed, mcpServerStates: new Map([["monid", "down"]]) })).level).toBe("error");
      expect(monidStatus(ctx({ ...signed, mcpServerStates: new Map([["monid", "disabled"]]) })).detail).toMatch(/turned off/);
    });

    it("reads the state of a renamed Monid server, not of a server named monid", () => {
      const renamed = { name: "my-monid", enabled: true, transport: { kind: "streamable_http", url: "https://mcp.monid.ai/v1" } };
      const s = monidStatus(
        ctx({
          servers: [renamed],
          mcpSignedIn: new Set(["my-monid"]),
          mcpServerStates: new Map([["my-monid", "up"]]),
        }),
      );
      expect(s.level).toBe("connected");
    });
  });
});

describe("monidHasSignIn (the disconnect verb's availability)", () => {
  it("is true only with a Monid server and a saved sign-in for it", () => {
    expect(monidHasSignIn(ctx({}))).toBe(false);
    expect(monidHasSignIn(ctx({ servers: [CATALOG_SERVER] }))).toBe(false);
    expect(monidHasSignIn(ctx({ servers: [CATALOG_SERVER], mcpSignedIn: new Set(["monid"]) }))).toBe(true);
    expect(monidHasSignIn(ctx({ servers: [CATALOG_SERVER], mcpSignedIn: new Set(["other"]) }))).toBe(false);
    const action = monidIntegration.actions?.find((a) => a.id === MONID_DISCONNECT_ACTION);
    expect(action?.available?.(ctx({ servers: [CATALOG_SERVER] }))).toBe(false);
    expect(action?.available?.(ctx({ servers: [CATALOG_SERVER], mcpSignedIn: new Set(["monid"]) }))).toBe(true);
  });
});
