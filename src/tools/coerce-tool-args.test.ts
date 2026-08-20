import { describe, it, expect } from "vitest";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "./tool-registry.js";
import { coerceToolArgs } from "./coerce-tool-args.js";

const ctx: ToolContext = {
  workingDir: "/w",
  sessionId: "s1",
  stepIndex: 0,
  signal: new AbortController().signal,
};

/** Records the args a tool actually received after registry coercion. */
function spyTool(name: string): { definition: ToolDefinition; seen: () => Record<string, unknown> } {
  let received: Record<string, unknown> = {};
  return {
    seen: () => received,
    definition: {
      name,
      description: name,
      readonly: true,
      run: async (args) => {
        received = args;
        return { status: "ok", summary: "", details: {} } as never;
      },
    },
  };
}

async function invokeWith(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const registry = new ToolRegistry();
  const spy = spyTool(name);
  registry.register(spy.definition);
  await registry.invoke(name, args, ctx);
  return spy.seen();
}

describe("coerceToolArgs — real failing calls from the campaign", () => {
  it("unwraps a stringified string[] for vision.describe (26 occurrences)", async () => {
    const seen = await invokeWith("vision.describe", {
      prompt: "read the numbers",
      paths: '["/var/crops/num_04.png", "/var/crops/num_05.png"]',
    });
    expect(seen.paths).toEqual(["/var/crops/num_04.png", "/var/crops/num_05.png"]);
    expect(seen.prompt).toBe("read the numbers");
  });

  it("unwraps stringified numbers for os.fs.read_document (15 occurrences)", async () => {
    const seen = await invokeWith("os.fs.read_document", {
      path: "census2011final_en.pdf",
      maxBytes: "200000",
      pagesFrom: "4",
      pagesTo: "12",
    });
    expect(seen).toEqual({
      path: "census2011final_en.pdf",
      maxBytes: 200000,
      pagesFrom: 4,
      pagesTo: 12,
    });
  });

  it("unwraps a stringified header object for os.http.request (3 occurrences)", async () => {
    const seen = await invokeWith("os.http.request", {
      url: "https://example.com",
      headers: '{"User-Agent": "Mozilla/5.0 (Macintosh)"}',
    });
    expect(seen.headers).toEqual({ "User-Agent": "Mozilla/5.0 (Macintosh)" });
    expect(seen.url).toBe("https://example.com");
  });

  it("unwraps a stringified number for browser.scroll (1 occurrence)", async () => {
    const seen = await invokeWith("browser.scroll", { direction: "down", amount: "3000" });
    expect(seen).toEqual({ direction: "down", amount: 3000 });
  });
});

describe("coerceToolArgs — the union case (browser.scroll `amount`)", () => {
  // `amount` is anyOf: ["page" | "half"] | number. The enum strings are
  // legal values as written and must survive; a numeric string is not.
  it("leaves the enum string \"page\" untouched", () => {
    expect(coerceToolArgs("browser.scroll", { direction: "down", amount: "page" })).toEqual({
      direction: "down",
      amount: "page",
    });
  });

  it("leaves the enum string \"half\" untouched", () => {
    expect(coerceToolArgs("browser.scroll", { direction: "up", amount: "half" })).toEqual({
      direction: "up",
      amount: "half",
    });
  });

  it("converts a numeric string on the same union field", () => {
    expect(coerceToolArgs("browser.scroll", { direction: "down", amount: "3000" })).toEqual({
      direction: "down",
      amount: 3000,
    });
  });

  it("passes an off-schema string through for the tool to reject", () => {
    expect(coerceToolArgs("browser.scroll", { direction: "down", amount: "lots" })).toEqual({
      direction: "down",
      amount: "lots",
    });
  });

  it("leaves a JSON-looking string on a string|object field alone", () => {
    // os.http.request.body accepts a raw string, so `{"a":1}` is a
    // legitimate body rather than an over-encoded object.
    const args = { url: "https://example.com", method: "POST", body: '{"a":1}' };
    expect(coerceToolArgs("os.http.request", args).body).toBe('{"a":1}');
  });
});

describe("coerceToolArgs — do no harm", () => {
  it("leaves a string value for a string-typed field alone", () => {
    const args = { path: "1234", format: "5" };
    expect(coerceToolArgs("os.fs.read_document", args)).toEqual(args);
  });

  it("passes an uncoercible number string through unchanged", () => {
    const args = { path: "a.pdf", maxBytes: "not-a-number" };
    expect(coerceToolArgs("os.fs.read_document", args)).toEqual(args);
    expect(coerceToolArgs("os.fs.read_document", args).maxBytes).toBe("not-a-number");
  });

  it("passes malformed JSON for an array field through without throwing", () => {
    const args = { prompt: "p", paths: "[broken" };
    expect(() => coerceToolArgs("vision.describe", args)).not.toThrow();
    expect(coerceToolArgs("vision.describe", args)).toEqual(args);
  });

  it("passes malformed JSON for an object field through without throwing", () => {
    const args = { url: "https://example.com", headers: "{not json" };
    expect(() => coerceToolArgs("os.http.request", args)).not.toThrow();
    expect(coerceToolArgs("os.http.request", args).headers).toBe("{not json");
  });

  it("does not coerce a JSON array of the wrong item type", () => {
    // vision.describe.paths is string[]; numbers must not slip through.
    const args = { prompt: "p", paths: "[1, 2, 3]" };
    expect(coerceToolArgs("vision.describe", args)).toEqual(args);
  });

  it("leaves an already-correct array untouched (no double parsing)", () => {
    const paths = ["/a.png", "/b.png"];
    const result = coerceToolArgs("vision.describe", { prompt: "p", paths });
    expect(result.paths).toBe(paths);
  });

  it("leaves already-correct numbers and objects untouched", () => {
    const args = { path: "a.pdf", maxBytes: 200000, pageSeparators: true };
    expect(coerceToolArgs("os.fs.read_document", args)).toEqual(args);
  });

  it("passes a tool with no registered schema through completely unchanged", () => {
    const args = { anything: "[1,2,3]", other: "500" };
    expect(coerceToolArgs("mcp.some.unregistered.tool", args)).toBe(args);
  });

  it("ignores unknown keys not present in the schema properties", () => {
    const args = { path: "a.pdf", bogusKey: "[1,2,3]" };
    expect(coerceToolArgs("os.fs.read_document", args)).toEqual(args);
  });

  it("does not mutate the caller's object", () => {
    const args = { prompt: "p", paths: '["/a.png"]' };
    const snapshot = { ...args };
    coerceToolArgs("vision.describe", args);
    expect(args).toEqual(snapshot);
    expect(args.paths).toBe('["/a.png"]');
  });

  it("returns the same reference when nothing needed coercing", () => {
    const args = { path: "a.pdf", maxBytes: 200 };
    expect(coerceToolArgs("os.fs.read_document", args)).toBe(args);
  });

  it("handles an empty args object", () => {
    expect(coerceToolArgs("vision.describe", {})).toEqual({});
  });

  it("leaves non-string values of the wrong type alone for the tool to reject", () => {
    // Only strings are candidates for unwrapping; a bad number stays bad.
    const args = { prompt: "p", paths: 42 };
    expect(coerceToolArgs("vision.describe", args)).toEqual(args);
  });
});

describe("ToolRegistry.invoke integration", () => {
  it("still dispatches to the right tool and returns its result", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "vision.describe",
      description: "d",
      readonly: true,
      run: async (args) => ({ status: "ok", summary: String(args.paths), details: {} }) as never,
    });
    const result = await registry.invoke(
      "vision.describe",
      { prompt: "p", paths: '["/a.png"]' },
      ctx,
    );
    expect(result.status).toBe("ok");
  });

  it("still throws ToolNotFoundError before any coercion", async () => {
    const registry = new ToolRegistry();
    await expect(registry.invoke("nope.missing", { a: "1" }, ctx)).rejects.toThrow(
      /tool not registered/,
    );
  });
});
