import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDynamicResourceClassResolver } from "../agent/tool-resource-class.js";
import { ToolRegistry } from "../tools/tool-registry.js";

import type {
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
  McpToolMeta,
} from "./mcp-types.js";

// Fake McpClient — driven from per-test fixtures. The manager
// imports `McpClient` from `./mcp-client.js`, so we swap that
// module wholesale via `vi.mock`. The factory is hoisted but kept
// trivial so each test can install its own behaviour through the
// `FAKE` shared object.
interface FakeBehaviour {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  catalog: McpServerCatalog;
}

const FAKE_BY_NAME = new Map<string, FakeBehaviour>();
const CONSTRUCTED: string[] = [];

vi.mock("./mcp-client.js", () => {
  class FakeMcpClient {
    private config: McpServerConfig;
    private connected = false;
    constructor(config: McpServerConfig) {
      this.config = config;
      CONSTRUCTED.push(config.name);
    }
    get name() {
      return this.config.name;
    }
    get isConnected() {
      return this.connected;
    }
    async connect(): Promise<void> {
      const b = FAKE_BY_NAME.get(this.config.name);
      if (!b) throw new Error(`no fake for ${this.config.name}`);
      await b.connect();
      this.connected = true;
    }
    async close(): Promise<void> {
      const b = FAKE_BY_NAME.get(this.config.name);
      this.connected = false;
      if (b) await b.close();
    }
    getCatalog(): McpServerCatalog {
      const b = FAKE_BY_NAME.get(this.config.name);
      return (
        b?.catalog ?? {
          server: this.config.name,
          tools: [],
          resources: [],
          prompts: [],
        }
      );
    }
    async callTool(): Promise<unknown> {
      return { content: [] };
    }
    async readResource(): Promise<unknown> {
      return { contents: [] };
    }
    async getPrompt(): Promise<unknown> {
      return { messages: [] };
    }
    async refreshCatalog(): Promise<McpServerCatalog> {
      return this.getCatalog();
    }
  }
  return { McpClient: FakeMcpClient };
});

// Imported AFTER the mock so the manager picks up the fake.
const { McpManager } = await import("./mcp-manager.js");

function metaOf(server: string, rawName: string): McpToolMeta {
  return {
    server,
    rawName,
    qualifiedName: `mcp.${server}.${rawName}`,
    description: "",
    inputSchema: { type: "object" },
    resourceClass: "approval_gated",
  };
}

function stdioConfig(name: string, enabled = true): McpServerConfig {
  return {
    name,
    enabled,
    transport: { kind: "stdio", command: "/bin/true" },
  };
}

describe("McpManager", () => {
  beforeEach(() => {
    FAKE_BY_NAME.clear();
    CONSTRUCTED.length = 0;
  });

  afterEach(() => {
    setDynamicResourceClassResolver(null);
  });

  it("constructs no clients when the config list is empty", () => {
    const tools = new ToolRegistry();
    const mgr = new McpManager([], { toolRegistry: tools });
    expect(mgr.listServerNames()).toEqual([]);
    expect(CONSTRUCTED).toEqual([]);
  });

  it("constructs one client per configured server", () => {
    const tools = new ToolRegistry();
    new McpManager([stdioConfig("a"), stdioConfig("b")], { toolRegistry: tools });
    expect(CONSTRUCTED).toEqual(["a", "b"]);
  });

  it("warns and drops duplicate server names", () => {
    const tools = new ToolRegistry();
    const warn = vi.fn();
    new McpManager([stdioConfig("a"), stdioConfig("a")], {
      toolRegistry: tools,
      logger: {
        info: () => {},
        warn,
        error: () => {},
        debug: () => {},
      } as never,
    });
    expect(warn).toHaveBeenCalled();
    expect(CONSTRUCTED).toEqual(["a"]);
  });

  it("start() connects enabled servers and registers their tools", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("docs", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "docs",
        tools: [metaOf("docs", "search"), metaOf("docs", "lookup")],
        resources: [],
        prompts: [],
      },
    });
    const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
    await mgr.start();
    expect(tools.has("mcp.docs.search")).toBe(true);
    expect(tools.has("mcp.docs.lookup")).toBe(true);
    expect(mgr.listStatuses()[0]!.state).toBe("up");
    expect(mgr.listStatuses()[0]!.toolCount).toBe(2);
  });

  it("start() isolates per-server failures", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("good", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "good",
        tools: [metaOf("good", "ping")],
        resources: [],
        prompts: [],
      },
    });
    FAKE_BY_NAME.set("bad", {
      connect: async () => {
        throw new Error("transport refused");
      },
      close: async () => {},
      catalog: { server: "bad", tools: [], resources: [], prompts: [] },
    });
    const mgr = new McpManager([stdioConfig("good"), stdioConfig("bad")], {
      toolRegistry: tools,
    });
    await mgr.start();
    expect(tools.has("mcp.good.ping")).toBe(true);
    const statuses = new Map(mgr.listStatuses().map((s) => [s.name, s]));
    expect(statuses.get("good")!.state).toBe("up");
    expect(statuses.get("bad")!.state).toBe("down");
    expect(statuses.get("bad")!.lastError).toContain("transport refused");
  });

  it("skips disabled servers entirely", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("docs", {
      connect: vi.fn(async () => {}),
      close: async () => {},
      catalog: {
        server: "docs",
        tools: [metaOf("docs", "search")],
        resources: [],
        prompts: [],
      },
    });
    const mgr = new McpManager([stdioConfig("docs", false)], {
      toolRegistry: tools,
    });
    await mgr.start();
    expect(tools.has("mcp.docs.search")).toBe(false);
    expect(mgr.listStatuses()[0]!.state).toBe("disabled");
  });

  it("emits status transitions through onStatus", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("docs", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "docs",
        tools: [metaOf("docs", "search")],
        resources: [],
        prompts: [],
      },
    });
    const events: McpServerStatus[] = [];
    const mgr = new McpManager([stdioConfig("docs")], {
      toolRegistry: tools,
      onStatus: (s) => events.push(s),
    });
    await mgr.start();
    const states = events.map((e) => e.state);
    // starting → up (no double-starting transition since constructor already
    // pre-sets state to "starting" for enabled configs; the manager's
    // `transition` helper short-circuits same-state writes)
    expect(states.at(-1)).toBe("up");
  });

  it("setServerEnabled(false) stops + unregisters tools", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("docs", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "docs",
        tools: [metaOf("docs", "search")],
        resources: [],
        prompts: [],
      },
    });
    const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
    await mgr.start();
    expect(tools.has("mcp.docs.search")).toBe(true);

    await mgr.setServerEnabled("docs", false);
    expect(tools.has("mcp.docs.search")).toBe(false);
    expect(mgr.listStatuses()[0]!.state).toBe("disabled");
  });

  it("shutdown() closes all clients and clears the resolver", async () => {
    const tools = new ToolRegistry();
    const closeSpy = vi.fn(async () => {});
    FAKE_BY_NAME.set("docs", {
      connect: async () => {},
      close: closeSpy,
      catalog: {
        server: "docs",
        tools: [metaOf("docs", "search")],
        resources: [],
        prompts: [],
      },
    });
    const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
    await mgr.start();
    expect(tools.has("mcp.docs.search")).toBe(true);

    await mgr.shutdown();
    expect(tools.has("mcp.docs.search")).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("listAllToolMeta aggregates across all connected servers", async () => {
    const tools = new ToolRegistry();
    FAKE_BY_NAME.set("a", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "a",
        tools: [metaOf("a", "x")],
        resources: [],
        prompts: [],
      },
    });
    FAKE_BY_NAME.set("b", {
      connect: async () => {},
      close: async () => {},
      catalog: {
        server: "b",
        tools: [metaOf("b", "y"), metaOf("b", "z")],
        resources: [],
        prompts: [],
      },
    });
    const mgr = new McpManager([stdioConfig("a"), stdioConfig("b")], {
      toolRegistry: tools,
    });
    await mgr.start();
    expect(mgr.listAllToolMeta().map((m) => m.qualifiedName).sort()).toEqual([
      "mcp.a.x",
      "mcp.b.y",
      "mcp.b.z",
    ]);
  });

  it("getClient / getCatalog return undefined for unknown servers", () => {
    const tools = new ToolRegistry();
    const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
    expect(mgr.getClient("hallucinated")).toBeUndefined();
    expect(mgr.getCatalog("hallucinated")).toBeUndefined();
  });

  describe("variant γ — live add / remove", () => {
    it("addServerLive connects a brand-new server and registers its tools", async () => {
      const tools = new ToolRegistry();
      FAKE_BY_NAME.set("docs", {
        connect: async () => {},
        close: async () => {},
        catalog: {
          server: "docs",
          tools: [metaOf("docs", "search"), metaOf("docs", "lookup")],
          resources: [],
          prompts: [],
        },
      });
      const mgr = new McpManager([], { toolRegistry: tools });
      await mgr.start();
      const result = await mgr.addServerLive(stdioConfig("docs"));
      expect(result.added).toBe(true);
      expect(result.tools).toHaveLength(2);
      expect(tools.has("mcp.docs.search")).toBe(true);
      expect(tools.has("mcp.docs.lookup")).toBe(true);
      const status = mgr.listStatuses().find((s) => s.name === "docs");
      expect(status?.state).toBe("up");
      expect(status?.toolCount).toBe(2);
    });

    it("addServerLive short-circuits on a duplicate name", async () => {
      const tools = new ToolRegistry();
      const connectSpy = vi.fn(async () => {});
      FAKE_BY_NAME.set("docs", {
        connect: connectSpy,
        close: async () => {},
        catalog: {
          server: "docs",
          tools: [metaOf("docs", "search")],
          resources: [],
          prompts: [],
        },
      });
      const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
      await mgr.start();
      expect(connectSpy).toHaveBeenCalledTimes(1);
      const result = await mgr.addServerLive(stdioConfig("docs"));
      expect(result.added).toBe(false);
      expect(result.tools).toEqual([]);
      // No second connect attempt.
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("addServerLive surfaces a downed server when connect fails (isolation)", async () => {
      const tools = new ToolRegistry();
      FAKE_BY_NAME.set("bad", {
        connect: async () => {
          throw new Error("transport refused");
        },
        close: async () => {},
        catalog: { server: "bad", tools: [], resources: [], prompts: [] },
      });
      const mgr = new McpManager([], { toolRegistry: tools });
      await mgr.start();
      const result = await mgr.addServerLive(stdioConfig("bad"));
      // The connect threw, but the server is now part of the manager
      // with state `down` and the add still counts as "added".
      expect(result.added).toBe(true);
      const status = mgr.listStatuses().find((s) => s.name === "bad");
      expect(status?.state).toBe("down");
      expect(status?.lastError).toContain("transport refused");
    });

    it("removeServerLive disconnects and unregisters tools", async () => {
      const tools = new ToolRegistry();
      const closeSpy = vi.fn(async () => {});
      FAKE_BY_NAME.set("docs", {
        connect: async () => {},
        close: closeSpy,
        catalog: {
          server: "docs",
          tools: [metaOf("docs", "search"), metaOf("docs", "lookup")],
          resources: [],
          prompts: [],
        },
      });
      const mgr = new McpManager([stdioConfig("docs")], { toolRegistry: tools });
      await mgr.start();
      expect(tools.has("mcp.docs.search")).toBe(true);
      const result = await mgr.removeServerLive("docs");
      expect(result.removed).toBe(true);
      expect(result.tools.sort()).toEqual(["mcp.docs.lookup", "mcp.docs.search"]);
      expect(tools.has("mcp.docs.search")).toBe(false);
      expect(tools.has("mcp.docs.lookup")).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(mgr.listServerNames()).not.toContain("docs");
    });

    it("removeServerLive on an absent name short-circuits", async () => {
      const tools = new ToolRegistry();
      const mgr = new McpManager([], { toolRegistry: tools });
      await mgr.start();
      const result = await mgr.removeServerLive("never-existed");
      expect(result.removed).toBe(false);
      expect(result.tools).toEqual([]);
    });

    it("round-trip add → remove leaves the registry in its original state", async () => {
      const tools = new ToolRegistry();
      FAKE_BY_NAME.set("docs", {
        connect: async () => {},
        close: async () => {},
        catalog: {
          server: "docs",
          tools: [metaOf("docs", "search")],
          resources: [],
          prompts: [],
        },
      });
      const mgr = new McpManager([], { toolRegistry: tools });
      await mgr.start();
      const before = tools.list().map((d) => d.name).sort();
      await mgr.addServerLive(stdioConfig("docs"));
      expect(tools.has("mcp.docs.search")).toBe(true);
      await mgr.removeServerLive("docs");
      const after = tools.list().map((d) => d.name).sort();
      expect(after).toEqual(before);
    });
  });
});
