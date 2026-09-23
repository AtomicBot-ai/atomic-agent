import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkTypeScriptFiles,
  findTsconfig,
  findTscBinary,
  TS_CHECKER,
} from "./check-typescript-syntax.js";

/** This repository's own tsc, resolved through the `.bin` symlink. */
const REAL_TSC = realpathSync(resolve(process.cwd(), "node_modules/.bin/tsc"));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atag-verify-ts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
  await symlink(REAL_TSC, join(dir, "node_modules", ".bin", "tsc"));
  return dir;
}

describe("findTsconfig / findTscBinary", () => {
  it("walk up from the file's directory", async () => {
    await project();
    await mkdir(join(dir, "src", "deep"));
    expect(findTsconfig(join(dir, "src", "deep"))).toBe(join(dir, "tsconfig.json"));
    expect(findTscBinary(join(dir, "src"))).toBe(join(dir, "node_modules", ".bin", "tsc"));
  });
});

describe("checkTypeScriptFiles", () => {
  it("gives no verdict without a tsconfig, and never a pass", async () => {
    const absolute = join(dir, "a.ts");
    await writeFile(absolute, "export const a: number = 1;\n");
    const [out] = await checkTypeScriptFiles([{ file: "a.ts", absolute }]);
    expect(out).toMatchObject({ ok: null, checker: "none" });
    expect(out?.error).toContain("no tsconfig.json");
  });

  it("gives no verdict when the project has no tsc", async () => {
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const absolute = join(dir, "a.ts");
    await writeFile(absolute, "export const a: number = 1;\n");
    const [out] = await checkTypeScriptFiles([{ file: "a.ts", absolute }]);
    expect(out).toMatchObject({ ok: null, checker: "none" });
    expect(out?.error).toContain("no node_modules/.bin/tsc");
  });

  it("runs tsc once per project and attributes diagnostics per file", async () => {
    await project();
    const good = join(dir, "src", "good.ts");
    const bad = join(dir, "src", "bad.ts");
    const outside = join(dir, "outside.ts");
    await writeFile(good, "export const a: number = 1;\n");
    await writeFile(bad, "export const b: number = 'no';\nexport const c = ;\n");
    await writeFile(outside, "export const d: number = 1;\n");
    const out = await checkTypeScriptFiles([
      { file: "src/good.ts", absolute: good },
      { file: "src/bad.ts", absolute: bad },
      { file: "outside.ts", absolute: outside },
    ]);
    expect(out[0]).toMatchObject({ file: "src/good.ts", ok: true, checker: TS_CHECKER });
    expect(out[0]?.warning).toContain("in other files");
    expect(out[1]).toMatchObject({ file: "src/bad.ts", ok: false, checker: TS_CHECKER });
    // tsc withholds semantic diagnostics while a file has parse errors,
    // so the one diagnostic is the parse error, with its line.
    expect(out[1]?.error).toMatch(/line 2: error TS1109/);
    expect(out[2]).toMatchObject({ file: "outside.ts", ok: null, checker: "none" });
    expect(out[2]?.error).toContain("not included by");
    // `--noEmit`: the check left nothing in the project.
    expect((await readdir(dir)).sort()).toEqual(
      ["node_modules", "outside.ts", "src", "tsconfig.json"].sort(),
    );
  }, 60_000);
});
