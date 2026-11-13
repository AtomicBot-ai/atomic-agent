import { describe, expect, it, vi } from "vitest";
import {
  callSiteToolExpression,
  listSiteToolsExpression,
  SITE_TOOLS_INIT_SCRIPT,
  SITE_TOOLS_REGISTRY_KEY,
} from "./site-tools-in-page.js";

/**
 * The WebMCP page scripts (ATO-521), run against a fake page: a plain
 * object stands in for `globalThis` with its own `document` and
 * `navigator`; Promise, Map, EventTarget and timers are Node's.
 */

type FakePage = Record<string, any>;

function fakePage(over: FakePage = {}): FakePage {
  return { document: {}, navigator: {}, ...over };
}

function runInit(page: FakePage): void {
  new Function("globalThis", SITE_TOOLS_INIT_SCRIPT)(page);
}

function evaluate(page: FakePage, expression: string): Promise<any> {
  return new Function("globalThis", `return ${expression};`)(page);
}

const LIMITS = { maxScan: 64, maxSchemaChars: 8_000, maxDescriptionChars: 1_000 };

function list(page: FakePage) {
  return evaluate(page, listSiteToolsExpression(LIMITS));
}

function call(page: FakePage, name: string, args: unknown, timeoutMs = 1_000) {
  return evaluate(
    page,
    callSiteToolExpression({ name, argsJson: JSON.stringify(args), timeoutMs, maxResultChars: 100 }),
  );
}

const addTool = {
  name: "add",
  title: "Add",
  description: "Add two numbers",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  annotations: { readOnlyHint: true },
  execute: async (input: { a: number; b: number }) => ({
    content: [{ type: "text", text: String(input.a + input.b) }],
  }),
};

describe("WebMCP page scripts", () => {
  it("gives a page without WebMCP a document.modelContext and records what it registers", async () => {
    const page = fakePage();
    runInit(page);
    expect(typeof page.document.modelContext.registerTool).toBe("function");
    expect(page.navigator.modelContext).toBe(page.document.modelContext);
    await page.document.modelContext.registerTool(addTool);
    const listed = await list(page);
    expect(listed.total).toBe(1);
    expect(listed.tools[0]).toEqual({
      name: "add",
      title: "Add",
      description: "Add two numbers",
      inputSchema: JSON.stringify(addTool.inputSchema),
      readOnlyHint: true,
    });
    expect(await page.document.modelContext.getTools()).toHaveLength(1);
    expect(await call(page, "add", { a: 1, b: 2 })).toEqual({ ok: true, isError: false, text: "3" });
  });

  it("follows the older navigator.modelContext calls and the abort signal", async () => {
    const page = fakePage();
    runInit(page);
    const mc = page.navigator.modelContext;
    mc.provideContext({ tools: [addTool, { ...addTool, name: "sub" }] });
    expect((await list(page)).tools.map((t: { name: string }) => t.name)).toEqual(["add", "sub"]);
    mc.unregisterTool("sub");
    expect((await list(page)).tools.map((t: { name: string }) => t.name)).toEqual(["add"]);
    mc.clearContext();
    expect((await list(page)).total).toBe(0);
    const controller = new AbortController();
    await mc.registerTool(addTool, { signal: controller.signal });
    expect((await list(page)).total).toBe(1);
    controller.abort();
    expect((await list(page)).total).toBe(0);
    // The old shape: registerTool(...).unregister()
    mc.registerTool(addTool).unregister();
    expect((await list(page)).total).toBe(0);
  });

  it("wraps a browser's own modelContext: the original still runs and the tool is recorded", async () => {
    const nativeRegister = vi.fn(async () => undefined);
    const page = fakePage({ document: { modelContext: { registerTool: nativeRegister } } });
    runInit(page);
    await page.document.modelContext.registerTool(addTool);
    expect(nativeRegister).toHaveBeenCalledTimes(1);
    expect((await list(page)).tools[0].name).toBe("add");
    // A registration the browser refused is not kept.
    nativeRegister.mockImplementationOnce(() => {
      throw new Error("bad schema");
    });
    expect(() => page.document.modelContext.registerTool({ ...addTool, name: "bad" })).toThrow("bad schema");
    expect((await list(page)).tools.map((t: { name: string }) => t.name)).toEqual(["add"]);
  });

  it("asks the browser's own getTools / executeTool when nothing was recorded", async () => {
    const executeTool = vi.fn(async () => "native answer");
    const page = fakePage({
      document: {
        modelContext: {
          getTools: async () => [{ name: "find", description: "Find", inputSchema: { type: "object" } }],
          executeTool,
        },
      },
    });
    // No init script: a page opened before the agent's capture was installed.
    expect((await list(page)).tools[0].name).toBe("find");
    expect(await call(page, "find", { q: "x" })).toEqual({ ok: true, isError: false, text: "native answer" });
    expect(executeTool.mock.calls[0]?.[1]).toEqual({ q: "x" });
    expect((await call(page, "missing", {})).error).toBe("not_found");
  });

  it("reports a timeout, a throw, an MCP error and a cut answer", async () => {
    const page = fakePage();
    runInit(page);
    const mc = page.document.modelContext;
    await mc.registerTool({ ...addTool, name: "hang", execute: () => new Promise(() => undefined) });
    await mc.registerTool({ ...addTool, name: "boom", execute: async () => { throw new Error("nope"); } });
    await mc.registerTool({ ...addTool, name: "err", execute: async () => ({ isError: true, content: [{ type: "text", text: "denied" }, { type: "image", data: "x" }] }) });
    await mc.registerTool({ ...addTool, name: "long", execute: async () => "x".repeat(500) });
    expect(await call(page, "hang", {}, 20)).toEqual({ ok: false, error: "timeout" });
    expect(await call(page, "boom", {})).toEqual({ ok: false, error: "threw", message: "nope" });
    expect(await call(page, "err", {})).toEqual({ ok: true, isError: true, text: "denied\n[image content not shown]" });
    expect((await call(page, "long", {})).text).toHaveLength(101);
    expect(await call(page, "nothing", {})).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses to run when the page is no longer on the approved host", async () => {
    const page = fakePage({ location: { hostname: "b.test" } });
    runInit(page);
    let ran = 0;
    await page.document.modelContext.registerTool({ ...addTool, execute: async () => { ran += 1; return "2"; } });
    const run = (host: string) =>
      evaluate(page, callSiteToolExpression({ name: "add", argsJson: "{}", timeoutMs: 1_000, maxResultChars: 100, host }));
    expect(await run("a.test")).toEqual({ ok: false, error: "wrong_host" });
    expect(ran).toBe(0);
    page.location.hostname = "B.Test.";
    expect(await run("b.test")).toEqual({ ok: true, isError: false, text: "2" });
    expect(ran).toBe(1);
  });

  it("caps schemas and descriptions in the page, and survives a hostile entry", async () => {
    const page = fakePage();
    runInit(page);
    const tools = page[SITE_TOOLS_REGISTRY_KEY].tools as Map<string, unknown>;
    tools.set("evil", { get name(): string { throw new Error("x"); }, execute: () => undefined });
    await page.document.modelContext.registerTool({
      ...addTool,
      name: "big",
      description: "d".repeat(5_000),
      inputSchema: { type: "object", description: "s".repeat(20_000) },
    });
    const listed = await list(page);
    expect(listed.total).toBe(2);
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0].description).toHaveLength(LIMITS.maxDescriptionChars + 1);
    expect(listed.tools[0].inputSchema).toHaveLength(LIMITS.maxSchemaChars + 1);
  });

  it("runs once per page", () => {
    const page = fakePage();
    runInit(page);
    const first = page.document.modelContext;
    runInit(page);
    expect(page.document.modelContext).toBe(first);
  });
});
