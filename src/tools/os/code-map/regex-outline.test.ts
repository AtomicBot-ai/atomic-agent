import { describe, expect, it } from "vitest";
import { regexOutline } from "./regex-outline.js";
import { stripSource } from "./strip-source.js";
import { languageForPath, signatureOf } from "./outline-types.js";

const names = (src: string, lang: Parameters<typeof regexOutline>[1]) =>
  regexOutline(src, lang).symbols.map((s) => `${s.depth}:${s.kind}:${s.name}${s.exported ? "+" : ""}@${s.line}`);

describe("languageForPath", () => {
  it("maps source extensions and skips declarations and bundles", () => {
    expect(languageForPath("a/b.ts")).toBe("typescript");
    expect(languageForPath("a/b.tsx")).toBe("tsx");
    expect(languageForPath("a/b.mjs")).toBe("javascript");
    expect(languageForPath("x.py")).toBe("python");
    expect(languageForPath("x.go")).toBe("go");
    expect(languageForPath("x.rs")).toBe("rust");
    expect(languageForPath("X.java")).toBe("java");
    expect(languageForPath("types.d.ts")).toBeNull();
    expect(languageForPath("vendor.min.js")).toBeNull();
    expect(languageForPath("README.md")).toBeNull();
    expect(languageForPath("Makefile")).toBeNull();
  });
});

describe("stripSource", () => {
  it("blanks comments and string contents but keeps every line", () => {
    const src = 'const a = "{ not a brace }"; // class Fake {\n/* function nope() {\n} */\nlet b = `x\n{`;\n';
    const out = stripSource(src, "typescript");
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("Fake");
    expect(out).not.toContain("nope");
    expect(out.split("{").length - 1).toBe(0);
  });

  it("keeps Rust lifetimes out of the string state", () => {
    const out = stripSource("fn f<'a>(x: &'a str) -> char { 'x' }\nstruct S;", "rust");
    expect(out).toContain("struct S;");
    expect(out).toContain("{");
  });

  it("blanks Python triple-quoted strings across lines", () => {
    const out = stripSource('"""\ndef hidden():\n"""\ndef shown():\n  pass # def nope\n', "python");
    expect(out).not.toContain("hidden");
    expect(out).toContain("def shown");
    expect(out).not.toContain("nope");
  });
});

describe("signatureOf", () => {
  it("cuts the body and caps the length", () => {
    expect(signatureOf("  export function foo(a: number): string {")).toBe("export function foo(a: number): string");
    expect(signatureOf("def run(self, x):")).toBe("def run(self, x)");
    expect(signatureOf("x".repeat(300)).length).toBe(120);
  });
});

describe("regexOutline: TypeScript", () => {
  it("reads top-level declarations, exports and class members one level down", () => {
    const src = [
      'import { x } from "./x.js";',
      "export interface Shape {",
      "  area(): number;",
      "}",
      "export type Id = string;",
      "export enum Color { Red }",
      "export const helper = (a: number) => a + 1;",
      "const LIMIT = 10;",
      "export async function main(): Promise<void> {",
      "  if (x) { run(); }",
      "}",
      "export class Circle implements Shape {",
      "  private r = 1;",
      "  constructor(r: number) { this.r = r; }",
      "  area(): number {",
      "    if (this.r) { return 1; }",
      "    return Math.PI;",
      "  }",
      "  private _hidden() {}",
      "  static make = (r: number) => new Circle(r);",
      "}",
      "function local() {}",
    ].join("\n");
    expect(names(src, "typescript")).toEqual([
      "0:interface:Shape+@2",
      "1:method:area+@3",
      "0:type:Id+@5",
      "0:enum:Color+@6",
      "0:function:helper+@7",
      "0:const:LIMIT@8",
      "0:function:main+@9",
      "0:class:Circle+@12",
      "1:method:constructor+@14",
      "1:method:area+@15",
      "1:method:_hidden@19",
      "1:method:make+@20",
      "0:function:local@22",
    ]);
  });

  it("does not take braces inside strings or comments for blocks", () => {
    const src = 'const s = "}}}";\n// }\nexport class A {\n  go() {}\n}\n';
    expect(names(src, "typescript")).toEqual(["0:const:s@1", "0:class:A+@3", "1:method:go+@4"]);
  });

  it("keeps top-level declarations after a regex literal with an unbalanced brace", () => {
    const src = [
      "const OPEN = /[{]/g;",
      "export function split(s: string) {",
      "  return s.split(/\\{/).map((p) => p.replace(/}{/, \"\"));",
      "}",
      "const half = total / 2 / count;",
      "export class AfterRegex {",
      "  run() {}",
      "}",
      "export function last() {}",
      "",
    ].join("\n");
    const got = names(src, "typescript");
    expect(got).toContain("0:function:split+@2");
    expect(got).toContain("0:class:AfterRegex+@6");
    expect(got).toContain("0:function:last+@9");
    const stripped = stripSource(src, "typescript");
    expect(stripped.split("\n")[0]).toBe("const OPEN = /   /g;");
    expect(stripped.split("\n")[4]).toBe("const half = total / 2 / count;");
    expect(stripSource("const re = /[/]{/;\n", "typescript")).toBe("const re = /    /;\n");
  });

  it("counts identifier mentions without keywords or short words", () => {
    const outline = regexOutline("import { parseConfig } from 'x';\nparseConfig(); parseConfig(); if (a) {}", "typescript");
    expect(outline.mentions.get("parseConfig")).toBe(3);
    expect(outline.mentions.has("if")).toBe(false);
    expect(outline.mentions.has("a")).toBe(false);
  });
});

describe("regexOutline: other languages", () => {
  it("Python: top level, class methods, constants, privacy by underscore", () => {
    const src = [
      "MAX_SIZE = 10",
      "class Store:",
      "    def __init__(self):",
      "        def inner():",
      "            pass",
      "    def _private(self):",
      "        pass",
      "    async def load(self):",
      "        pass",
      "def helper():",
      "    pass",
    ].join("\n");
    expect(names(src, "python")).toEqual([
      "0:const:MAX_SIZE+@1",
      "0:class:Store+@2",
      "1:method:__init__+@3",
      "1:method:_private@6",
      "1:method:load+@8",
      "0:function:helper+@10",
    ]);
  });

  it("Go: funcs, methods with receivers, types, interface methods, export by case", () => {
    const src = [
      "package main",
      "type Server struct {",
      "  addr string",
      "}",
      "type Handler interface {",
      "  Serve(w Writer) error",
      "}",
      "func (s *Server) Start() error {",
      "  return nil",
      "}",
      "func helper() {}",
      "const Version = \"1\"",
    ].join("\n");
    expect(names(src, "go")).toEqual([
      "0:struct:Server+@2",
      "0:interface:Handler+@5",
      "1:method:Serve+@6",
      "0:method:Start+@8",
      "0:function:helper@11",
      "0:const:Version+@12",
    ]);
  });

  it("Rust: items, impl blocks and their fns, pub as exported", () => {
    const src = [
      "pub struct Config { pub name: String }",
      "impl Config {",
      "    pub fn new() -> Self { Config { name: String::new() } }",
      "    fn secret(&self) {}",
      "}",
      "pub trait Run {",
      "    fn run(&self);",
      "}",
      "fn main() {}",
      "pub(crate) mod util;",
    ].join("\n");
    expect(names(src, "rust")).toEqual([
      "0:struct:Config+@1",
      "0:impl:Config+@2",
      "1:method:new+@3",
      "1:method:secret@4",
      "0:trait:Run+@6",
      "1:method:run+@7",
      "0:function:main@9",
      "0:module:util+@10",
    ]);
  });

  it("Java: classes, public methods, constructors, not field initialisers", () => {
    const src = [
      "package a;",
      "public class Repo {",
      "    private final Map<String, Item> items = new HashMap<>();",
      "    public Repo() {}",
      "    @Override",
      "    public Item find(String id) {",
      "        return items.get(id);",
      "    }",
      "    void reset() {}",
      "}",
    ].join("\n");
    expect(names(src, "java")).toEqual([
      "0:class:Repo+@2",
      "1:method:Repo+@4",
      "1:method:find+@6",
      "1:method:reset@9",
    ]);
  });

  it("Java: Allman braces still open the class body", () => {
    const src = "public class A\n{\n    public void go()\n    {\n    }\n}\n";
    expect(names(src, "java")).toEqual(["0:class:A+@1", "1:method:go+@3"]);
  });
});
