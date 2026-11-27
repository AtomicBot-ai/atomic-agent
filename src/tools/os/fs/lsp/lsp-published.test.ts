import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PublishedDiagnosticsStore, filePathOf } from "./lsp-published.js";

const uri = (p: string) => pathToFileURL(p).href;

describe("PublishedDiagnosticsStore (ATO-2472)", () => {
  it("keeps the latest publish per file and drops a file published clean", () => {
    const store = new PublishedDiagnosticsStore();
    store.remember("a", uri("/w/a.ts"), [{ message: "old" }]);
    store.remember("a", uri("/w/a.ts"), [{ message: "new" }]);
    store.remember("b", uri("/w/b.ts"), [{ message: "b" }]);
    expect(store.list().map((f) => [f.path, f.diagnostics[0]?.message])).toEqual([["/w/a.ts", "new"], ["/w/b.ts", "b"]]);
    store.remember("a", uri("/w/a.ts"), []);
    expect(store.list().map((f) => f.path)).toEqual(["/w/b.ts"]);
  });

  it("forgets the file published longest ago past the cap, and ignores other schemes", () => {
    const store = new PublishedDiagnosticsStore(2);
    for (const name of ["a", "b", "c"]) store.remember(name, uri(`/w/${name}.ts`), [{ message: name }]);
    store.remember("u", "untitled:Untitled-1", [{ message: "x" }]);
    expect(store.list().map((f) => f.path)).toEqual(["/w/b.ts", "/w/c.ts"]);
    expect(filePathOf("untitled:x")).toBeNull();
  });
});
