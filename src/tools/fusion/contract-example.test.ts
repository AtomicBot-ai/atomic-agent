import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeProvide, renderContractForTask } from "./contract.js";
import {
  MAX_EXAMPLE_CODE_CHARS,
  checksWithExamples,
  contractExampleChecks,
  exampleNodeScript,
  examplePageExpr,
  exampleRoot,
  parseProvideExample,
} from "./contract-example.js";
import { parseDelegateArgs } from "./delegate-args.js";

/**
 * The break this exists to catch: `PHYS.corners(b)` was declared as
 * `{w: world point, o: local offset}`, presence was green, the page had
 * no console errors, and three scenes of five drew wrong. A box centred
 * at (10, 10) must have world corners near 10 and offsets near 0.
 */
const CALL = "PHYS.corners({x:10,y:10,w:2,h:2,a:0})";
const EXPECT =
  "Array.isArray(r) && r.length === 4 && r.every(c => Math.abs(c.w.x - 10) <= 1 && Math.abs(c.o.x) <= 1)";

const RIGHT = `{ corners: (b) => [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx, dy]) => ({ w: { x: b.x + dx, y: b.y + dy }, o: { x: dx, y: dy } })) }`;
/** The same function with the two fields swapped — what the drawing worker effectively read. */
const SWAPPED = `{ corners: (b) => [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx, dy]) => ({ o: { x: b.x + dx, y: b.y + dy }, w: { x: dx, y: dy } })) }`;

const TASKS = [
  { id: "phys", instructions: "write the physics" },
  { id: "draw", instructions: "write the renderer" },
];

function contractWith(example: unknown, extra: Record<string, unknown> = {}) {
  return parseDelegateArgs({
    tasks: TASKS,
    contract: {
      owners: { "js/phys.js": "phys", "js/draw.js": "draw" },
      provides: [
        { task: "phys", kind: "symbol", name: "PHYS.corners", ...extra, example },
      ],
      requires: [{ task: "draw", name: "PHYS.corners" }],
      checks: [{ task: "draw", kind: "page", path: "index.html", checks: ["no errors"] }],
    },
  });
}

/** Evaluate the page probe the way the page would: globals in scope, promise awaited. */
async function runPageProbe(phys: string, expr: string): Promise<unknown> {
  const g = globalThis as Record<string, unknown>;
  g.PHYS = (0, eval)(`(${phys})`);
  try {
    return await (0, eval)(expr);
  } finally {
    delete g.PHYS;
  }
}

describe("parseProvideExample", () => {
  it("is no example when absent, null or default-filled blank", () => {
    expect(parseProvideExample(undefined, "p")).toEqual({});
    expect(parseProvideExample(null, "p")).toEqual({});
    expect(parseProvideExample({ call: "", expect: " ", page: "" }, "p")).toEqual({});
  });

  it("keeps call, expect and a non-blank page", () => {
    expect(parseProvideExample({ call: CALL, expect: EXPECT, page: "" }, "p")).toEqual({
      example: { call: CALL, expect: EXPECT },
    });
    expect(
      parseProvideExample({ call: CALL, expect: EXPECT, page: "index.html" }, "p"),
    ).toEqual({ example: { call: CALL, expect: EXPECT, page: "index.html" } });
  });

  it("names the field when half of it is missing, it is not an object, or code is too long", () => {
    expect(parseProvideExample({ call: CALL }, "p").problem).toMatch(/p\.example needs both `call`/);
    expect(parseProvideExample("PHYS.corners()", "p").problem).toMatch(/must be an object/);
    const long = "x".repeat(MAX_EXAMPLE_CODE_CHARS + 1);
    expect(parseProvideExample({ call: CALL, expect: long }, "p").problem).toMatch(
      /p\.example\.expect is \d+ chars/,
    );
  });
});

describe("a contract without examples", () => {
  it("runs exactly its declared checks, as before", () => {
    const parsed = contractWith(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    expect(parsed.contract.provides?.[0]).not.toHaveProperty("example");
    expect(checksWithExamples(parsed.contract)).toEqual(parsed.contract.checks);
    expect(describeProvide(parsed.contract.provides![0]!)).toBe("symbol PHYS.corners");
  });
});

describe("a provide with an example", () => {
  it("becomes a page probe for browser code, attributed to the producer, after the declared checks", () => {
    const parsed = contractWith({ call: CALL, expect: EXPECT, page: "index.html" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    const all = checksWithExamples(parsed.contract);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(parsed.contract.checks![0]);
    expect(all[1]).toMatchObject({
      task: "phys",
      kind: "page",
      path: "index.html",
      probes: [{ name: "PHYS.corners" }],
      checks: ["probe PHYS.corners equals true"],
    });
    expect(parsed.contract.warnings).toBeUndefined();
  });

  it("tells the producer how it will be checked", () => {
    const parsed = contractWith({ call: CALL, expect: EXPECT, page: "index.html" });
    if (!parsed.ok || parsed.contract === undefined) throw new Error("parse");
    const own = renderContractForTask(parsed.contract, "phys");
    expect(own).toContain(`checked after the fan-out by calling \`${CALL}\` in index.html`);
  });

  it("becomes a node command loading `in` when there is no page", () => {
    const parsed = contractWith({ call: CALL, expect: EXPECT }, { in: "js/phys.js" });
    if (!parsed.ok || parsed.contract === undefined) throw new Error("parse");
    const [check] = contractExampleChecks(parsed.contract);
    expect(check).toMatchObject({ task: "phys", kind: "command", cmd: "node" });
    expect((check!.args as string[]).slice(0, 2)).toEqual(["--input-type=module", "-e"]);
  });

  it("is a warning, not a refusal, with nowhere to run — and runs nothing", () => {
    const parsed = contractWith({ call: CALL, expect: EXPECT });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.contract === undefined) return;
    expect(contractExampleChecks(parsed.contract)).toEqual([]);
    expect(parsed.contract.warnings).toEqual([
      'provides "PHYS.corners" (task phys) example cannot run: give `example.page` (browser code) or `in` (a file node can load)',
    ]);
  });

  it("refuses a malformed example with the field named", () => {
    const parsed = contractWith({ call: CALL });
    expect(parsed.ok).toBe(false);
  });
});

describe("the page probe", () => {
  it("is true for a producer that returns what it declared", async () => {
    expect(await runPageProbe(RIGHT, examplePageExpr({ call: CALL, expect: EXPECT }))).toBe(true);
  });

  it("says what came back when world and offset are swapped", async () => {
    const value = await runPageProbe(SWAPPED, examplePageExpr({ call: CALL, expect: EXPECT }));
    expect(value).toMatch(/^expect was false for r = \[\{"o":\{"x":9/);
  });

  it("says the call threw rather than passing", async () => {
    const value = await runPageProbe("{}", examplePageExpr({ call: CALL, expect: EXPECT }));
    expect(value).toMatch(/^call threw: .*corners/);
  });
});

describe("exampleRoot", () => {
  it("finds the identifier the call starts from", () => {
    expect(exampleRoot(CALL)).toBe("PHYS");
    expect(exampleRoot("await api.get(1)")).toBe("api");
    expect(exampleRoot("window.PHYS.corners()")).toBeNull();
    expect(exampleRoot("(() => 1)()")).toBeNull();
  });
});

describe("the node script", () => {
  const files: Record<string, (phys: string) => string> = {
    "phys.mjs": (phys) => `export const PHYS = ${phys};`,
    "phys.cjs": (phys) => `module.exports = { PHYS: ${phys} };`,
    // A plain browser-style script: a top-level const, no export at all.
    "phys-script.js": (phys) => `const PHYS = ${phys};`,
  };

  function run(file: string, body: string): { ok: boolean; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "contract-example-"));
    try {
      writeFileSync(join(dir, file), body);
      const script = exampleNodeScript({ call: CALL, expect: EXPECT }, file);
      try {
        const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20_000,
        });
        return { ok: true, out };
      } catch (error) {
        const e = error as { stderr?: string };
        return { ok: false, out: String(e.stderr ?? "") };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [file, body] of Object.entries(files)) {
    it(`passes a right producer and fails a swapped one (${file})`, () => {
      expect(run(file, body(RIGHT))).toEqual({ ok: true, out: "example ok\n" });
      const swapped = run(file, body(SWAPPED));
      expect(swapped.ok).toBe(false);
      expect(swapped.out).toMatch(/example: expect was false for r = /);
    });
  }

  it("fails loudly when the file never exposes the call's root", () => {
    const result = run("other.mjs", "export const NOT_PHYS = 1;");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/example: PHYS is not reachable after loading other\.mjs/);
  });
});
