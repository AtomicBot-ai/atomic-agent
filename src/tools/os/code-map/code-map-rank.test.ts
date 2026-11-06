import { describe, expect, it } from "vitest";
import { rankFiles, type RankInput } from "./code-map-rank.js";
import { renderFileOutline, renderProjectMap } from "./code-map-render.js";
import { regexOutline } from "./regex-outline.js";

function file(path: string, src: string): RankInput {
  return { path, outline: regexOutline(src, "typescript") };
}

const CORE = file("src/core.ts", "export class ConfigLoader {\n  load() {}\n}\nexport function parseSettings() {}\n");
const A = file("src/a.ts", "import { ConfigLoader } from './core';\nnew ConfigLoader(); parseSettings();\nexport function featureA() {}\n");
const B = file("src/b.ts", "import { ConfigLoader } from './core';\nnew ConfigLoader();\nexport function featureB() { featureA(); }\n");
const LEAF = file("src/leaf.ts", "export function lonely() {}\n");

describe("rankFiles", () => {
  it("puts the most-referenced file first and an unreferenced one last", () => {
    const ranked = rankFiles([LEAF, A, B, CORE]);
    expect(ranked[0]!.path).toBe("src/core.ts");
    expect(ranked[ranked.length - 1]!.path).toBe("src/leaf.ts");
  });

  it("ranks a file's symbols by the references that reached it", () => {
    const core = rankFiles([A, B, CORE]).find((f) => f.path === "src/core.ts")!;
    expect(core.symbols[0]!.symbol.name).toBe("ConfigLoader");
  });

  it("focus on a file or a name tilts the ranking towards it", () => {
    expect(rankFiles([A, B, CORE, LEAF], { files: new Set(["src/leaf.ts"]) })[0]!.path).toBe("src/leaf.ts");
    expect(rankFiles([A, B, CORE, LEAF], { idents: new Set(["lonely"]) })[0]!.path).toBe("src/leaf.ts");
  });

  it("is deterministic and handles an empty project", () => {
    expect(rankFiles([])).toEqual([]);
    const once = rankFiles([A, B, CORE]).map((f) => f.path);
    expect(rankFiles([CORE, B, A]).map((f) => f.path)).toEqual(once);
  });
});

describe("renderProjectMap / renderFileOutline", () => {
  it("prints files best first with symbols in line order, within the budget", () => {
    const ranked = rankFiles([LEAF, A, B, CORE]);
    const map = renderProjectMap(ranked, 2_000);
    const lines = map.text.split("\n");
    expect(lines[0]).toBe("src/core.ts");
    expect(lines[1]).toBe("  L1 export class ConfigLoader");
    expect(lines[2]).toBe("    L2 load()");
    expect(map.filesShown).toBe(4);
    expect(map.filesTotal).toBe(4);
  });

  it("stops before the budget and says how many files it shows", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      file(`src/f${i}.ts`, `export function someLongFunctionName${i}(argumentOne: string, argumentTwo: number) {}\n`),
    );
    const map = renderProjectMap(rankFiles(many), 200);
    expect(map.tokens).toBeLessThanOrEqual(200);
    expect(map.filesShown).toBeLessThan(40);
    expect(map.filesTotal).toBe(40);
  });

  it("outlines one file with every symbol and its line", () => {
    const out = renderFileOutline("src/core.ts", CORE.outline, 1_000);
    expect(out.text.split("\n")).toEqual([
      "src/core.ts (5 lines, 3 symbols)",
      "  L1 export class ConfigLoader",
      "    L2 load()",
      "  L4 export function parseSettings()",
    ]);
  });
});
