import { describe, expect, it } from "vitest";

import { ownMcpServerCheck } from "./own-mcp-servers.js";

// Review round 1 (F2072.2): a server the person adds mid-session may use
// tool secrets at once. The old check was a Set of names built at start,
// so a new server was refused as if a plugin had brought it.
describe("ownMcpServerCheck", () => {
  it("allows a server added to config.json after start", () => {
    const servers: { name: string }[] = [{ name: "github" }];
    const own = ownMcpServerCheck({
      liveServers: () => servers,
      alwaysOwn: new Set(["composio"]),
      pluginServerNames: new Set(["acme-search"]),
    });
    expect(own({ name: "linear" })).toBe(false);
    servers.push({ name: "linear" });
    expect(own({ name: "linear" })).toBe(true);
    expect(own({ name: "github" })).toBe(true);
    expect(own({ name: "composio" })).toBe(true);
  });

  it("never allows a plugin's server, even under a name config.json also has", () => {
    const own = ownMcpServerCheck({
      liveServers: () => [{ name: "acme-search" }],
      alwaysOwn: new Set(),
      pluginServerNames: new Set(["acme-search"]),
    });
    expect(own({ name: "acme-search" })).toBe(false);
  });

  it("forgets a server removed from config.json", () => {
    let servers: { name: string }[] = [{ name: "linear" }];
    const own = ownMcpServerCheck({ liveServers: () => servers, alwaysOwn: new Set(), pluginServerNames: new Set() });
    expect(own({ name: "linear" })).toBe(true);
    servers = [];
    expect(own({ name: "linear" })).toBe(false);
  });
});
