import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsShellTool } from "./shell.js";
import { nodeCheckMultiFileNotice, nodeCheckPaths } from "./node-check-notice.js";

describe("node --check over several paths (F9a)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-node-check-"));
    await mkdir(join(dir, "js"));
    for (const name of ["a.js", "b.js", "c.js"]) {
      await writeFile(join(dir, "js", name), "const x = 1;\n");
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the paths node would see, flags skipped", () => {
    expect(nodeCheckPaths("node --check js/a.js js/b.js", dir)).toEqual([
      "js/a.js",
      "js/b.js",
    ]);
    expect(nodeCheckPaths("node -c --no-warnings js/a.js", dir)).toEqual([
      "js/a.js",
    ]);
    expect(nodeCheckPaths("/usr/local/bin/node --check 'js/a.js'", dir)).toEqual([
      "js/a.js",
    ]);
  });

  it("expands a glob the way the subshell would", () => {
    // On the subshell path the tool hands `node --check js/*.js` to
    // `sh -c` as written and never sees the argv; the notice has to
    // count what the shell will produce.
    expect(nodeCheckPaths("node --check js/*.js", dir)).toEqual([
      "js/a.js",
      "js/b.js",
      "js/c.js",
    ]);
    // A pattern matching nothing passes through verbatim, as in POSIX.
    expect(nodeCheckPaths("node --check js/*.ts", dir)).toEqual(["js/*.ts"]);
  });

  it("finds the check behind a separator and ignores lines without one", () => {
    expect(nodeCheckPaths("cd js && node --check a.js b.js", join(dir, "js"))).toEqual([
      "a.js",
      "b.js",
    ]);
    expect(nodeCheckPaths("node js/a.js js/b.js", dir)).toBeNull();
    expect(nodeCheckPaths("node -e 'console.log(1)'", dir)).toBeNull();
    expect(nodeCheckPaths("python3 -c 'print(1)'", dir)).toBeNull();
    expect(nodeCheckPaths("ls", dir)).toBeNull();
  });

  it("notices only when more than one path is checked", () => {
    expect(nodeCheckMultiFileNotice("node --check js/a.js", dir)).toBeNull();
    expect(nodeCheckMultiFileNotice("ls js", dir)).toBeNull();
    const notice = nodeCheckMultiFileNotice("node --check js/*.js", dir);
    expect(notice).toContain("node --check checks only the first file (js/a.js)");
    expect(notice).toContain("run one command per file");
    expect(notice).toContain("2 paths were not checked");
  });

  it("prepends the notice to the shell tool's result, structured and subshell forms", async () => {
    // Run 12 replied "ran node --check on all JavaScript files (all
    // passed)" after exactly this command. Exit 0 says nothing; the
    // result now does, before the `$ …` header so a capped result still
    // shows it.
    const gate = new ApprovalGate({ emit: () => undefined });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: false });
    const ctx: ToolContext = {
      sessionId: "test-session",
      workingDir: dir,
      signal: new AbortController().signal,
    };
    const structured = await tool.run(
      { cmd: "node", args: ["--check", "js/a.js", "js/b.js"] },
      ctx,
    );
    expect(structured.status).toBe("ok");
    expect(structured.summary.startsWith("node --check checks only the first file (js/a.js)")).toBe(true);
    expect(structured.summary).toContain("$ node --check js/a.js js/b.js");

    const subshell = await tool.run({ cmd: "node --check js/*.js" }, ctx);
    expect(subshell.status).toBe("ok");
    expect(subshell.summary.startsWith("node --check checks only the first file (js/a.js)")).toBe(true);

    const single = await tool.run({ cmd: "node", args: ["--check", "js/a.js"] }, ctx);
    expect(single.summary.startsWith("$ node --check js/a.js")).toBe(true);
  });
});
