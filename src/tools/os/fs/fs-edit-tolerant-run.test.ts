import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { tolerantMatchNote } from "./fs-edit-tolerant.js";

/** `os.fs.edit` end to end on the tolerant chain (ATO-692). */
describe("os.fs.edit tolerant matching", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-edit-tolerant-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildOsFsEditTool({ approvals: gate, approvalRequired: true });
  }

  function ctx(): ToolContext {
    return {
      workingDir: dir,
      sessionId: "test-session",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  it("prefers the exact match over a tolerant one", async () => {
    await writeFile(join(dir, "a.txt"), "a  b\na b\n", "utf8");
    const result = await tool().run({ path: "a.txt", oldString: "a b", newString: "a c" }, ctx());
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a  b\na c\n");
    expect(result.summary.startsWith("note:")).toBe(false);
    expect(result.details.matchedBy).toBeUndefined();
  });

  it("applies a shifted-indentation match, re-indents newString and says so", async () => {
    await writeFile(join(dir, "f.py"), "def f():\n        if x:\n            go()\n", "utf8");
    const result = await tool().run(
      { path: "f.py", oldString: "    if x:\n        go()", newString: "    if x:\n        stop()" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary.split("\n")[0]).toBe(tolerantMatchNote("indentation", true));
    expect(result.details).toMatchObject({ matchedBy: "indentation", replacedOccurrences: 1 });
    expect(await readFile(join(dir, "f.py"), "utf8")).toBe("def f():\n        if x:\n            stop()\n");
  });

  it("matches straight quotes against a CRLF file's curly ones and keeps it CRLF", async () => {
    await writeFile(join(dir, "doc.md"), "Say \u201chi\u201d\r\nthen go\r\n", "utf8");
    const result = await tool().run(
      { path: "doc.md", oldString: 'Say "hi"\nthen go', newString: 'Say "bye"\nthen stay' },
      ctx(),
    );
    expect(result.details.matchedBy).toBe("typography");
    expect(await readFile(join(dir, "doc.md"), "utf8")).toBe('Say "bye"\r\nthen stay\r\n');
  });

  it("with replaceAll and no exact occurrence, replaces only the one tolerant match", async () => {
    await writeFile(join(dir, "c.ts"), "const total =   price;\n", "utf8");
    const result = await tool().run(
      { path: "c.ts", oldString: "total = price", newString: "sum = price", replaceAll: true },
      ctx(),
    );
    expect(result.details).toMatchObject({ matchedBy: "inner-whitespace", replacedOccurrences: 1 });
    expect(await readFile(join(dir, "c.ts"), "utf8")).toBe("const sum = price;\n");
  });

  it("leaves the file untouched when a tolerant level fits two places", async () => {
    const before = "if x:\n    go()\nif x:\n        go()\n";
    await writeFile(join(dir, "two.py"), before, "utf8");
    await expect(
      tool().run({ path: "two.py", oldString: "if x:\ngo()", newString: "if y:\ngo()" }, ctx()),
    ).rejects.toThrow(/matches 2 places, so nothing was changed/);
    expect(await readFile(join(dir, "two.py"), "utf8")).toBe(before);
  });
});
