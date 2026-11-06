import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineBackends, loadTreeSitterBackend, outlineFromTree } from "./tree-sitter-outline.js";
import { regexOutlineBackend } from "./regex-outline.js";
import type { OutlineBackend } from "./outline-types.js";

interface FakeNode {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: FakeNode[];
  fields?: Record<string, FakeNode>;
  childForFieldName(name: string): FakeNode | null;
}

function node(type: string, text: string, row: number, children: FakeNode[] = [], fields: Record<string, FakeNode> = {}): FakeNode {
  return { type, text, startPosition: { row }, namedChildren: children, fields, childForFieldName: (n) => fields[n] ?? null };
}

describe("outlineFromTree", () => {
  it("reads exported declarations, class members and identifier mentions from a TS tree", () => {
    const source = "export class Store {\n  load() {}\n}\nfunction helper() { Store; }\n";
    const className = node("type_identifier", "Store", 0);
    const methodName = node("property_identifier", "load", 1);
    const method = node("method_definition", "load() {}", 1, [methodName], { name: methodName });
    const body = node("class_body", "{...}", 0, [method]);
    const cls = node("class_declaration", "class Store {...}", 0, [className, body], { name: className, body });
    const exp = node("export_statement", "export class ...", 0, [cls]);
    const fnName = node("identifier", "helper", 3);
    const use = node("identifier", "Store", 3);
    const fn = node("function_declaration", "function helper() { Store; }", 3, [fnName, use], { name: fnName });
    const root = node("program", source, 0, [exp, fn]);

    const outline = outlineFromTree(root, source, "typescript");
    expect(outline.symbols.map((s) => `${s.depth}:${s.kind}:${s.name}:${s.exported}@${s.line}`)).toEqual([
      "0:class:Store:true@1",
      "1:method:load:true@2",
      "0:function:helper:false@4",
    ]);
    expect(outline.symbols[0]!.signature).toBe("export class Store");
    expect(outline.mentions.get("Store")).toBe(2);
  });
});

describe("loadTreeSitterBackend", () => {
  it("is null without a grammar dir, without the module, or without any grammar", async () => {
    expect(await loadTreeSitterBackend(undefined)).toBeNull();
    expect(await loadTreeSitterBackend("/nowhere", async () => { throw new Error("Cannot find module"); })).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), "atomic-ts-grammars-"));
    try {
      class Parser { static async init() {} static Language = { load: async () => ({}) }; setLanguage() {} parse() { return null; } }
      expect(await loadTreeSitterBackend(dir, async () => ({ default: Parser }))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports exactly the languages whose WASM loaded (0.25-style named exports)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-ts-grammars-"));
    try {
      await writeFile(join(dir, "tree-sitter-python.wasm"), "");
      class Parser { static async init() {} setLanguage() {} parse() { return null; } }
      const Language = { load: async (path: string) => ({ path }) };
      const backend = await loadTreeSitterBackend(dir, async () => ({ Parser, Language }));
      expect(backend).not.toBeNull();
      expect(backend!.supports("python")).toBe(true);
      expect(backend!.supports("typescript")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("combineBackends", () => {
  it("falls back to regex for unsupported languages and for files the primary throws on", async () => {
    const primary: OutlineBackend = {
      id: "tree-sitter",
      supports: (lang) => lang === "python",
      outline: () => { throw new Error("parse failed"); },
    };
    const combined = combineBackends(primary, regexOutlineBackend);
    expect(combined.id).toBe("tree-sitter+regex");
    const ts = await combined.outline("export function a() {}", "typescript");
    expect(ts.symbols.map((s) => s.name)).toEqual(["a"]);
    const py = await combined.outline("def b():\n  pass\n", "python");
    expect(py.symbols.map((s) => s.name)).toEqual(["b"]);
    expect(combineBackends(null, regexOutlineBackend)).toBe(regexOutlineBackend);
  });
});
