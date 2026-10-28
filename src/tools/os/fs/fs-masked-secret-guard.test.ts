import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { addedMaskedMarker, refuseMaskedSecretWrite } from "./fs-masked-secret-guard.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { buildOsFsWriteTool } from "./fs-write.js";

const ENV = "OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef\nLOG_LEVEL=info\n";
const MASKED = "OPENROUTER_API_KEY=[redacted:openrouter-key]\nLOG_LEVEL=info\n";

describe("addedMaskedMarker (ATO-1077)", () => {
  it("finds a marker the new text adds", () => {
    expect(addedMaskedMarker(ENV, MASKED)).toBe("[redacted:openrouter-key]");
    expect(addedMaskedMarker("", "token: [redacted:secret]")).toBe("[redacted:secret]");
  });

  it("allows markers the file already held, but not one more copy", () => {
    const doc = "Output shows `[redacted:secret]` in place of a key.\n";
    expect(addedMaskedMarker(doc, `${doc}More text.\n`)).toBeNull();
    expect(addedMaskedMarker(doc, `${doc}Again: [redacted:secret]\n`)).toBe("[redacted:secret]");
  });

  it("ignores text without a marker and look-alikes", () => {
    expect(addedMaskedMarker("a", "b")).toBeNull();
    expect(addedMaskedMarker("", "[redacted: with spaces] [redacted:]")).toBeNull();
  });

  it("throws a message that names the tool, the file and the marker", () => {
    expect(() => refuseMaskedSecretWrite("os.fs.write", ".env", ENV, MASKED)).toThrow(
      /os\.fs\.write: .*\[redacted:openrouter-key\].*\.env.*Nothing was written/,
    );
    expect(() => refuseMaskedSecretWrite("os.fs.write", ".env", ENV, ENV)).not.toThrow();
  });
});

describe("os.fs write tools refuse to write a masked marker over a secret", () => {
  let dir: string;
  let asked: number;

  function gate(): ApprovalGate {
    const g = new ApprovalGate({
      emit: (req) => {
        asked += 1;
        g.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    return g;
  }

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-masked-guard-"));
    asked = 0;
    await writeFile(join(dir, ".env"), ENV, "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("os.fs.write replace and append", async () => {
    const tool = buildOsFsWriteTool({ approvals: gate(), approvalRequired: true });
    await expect(tool.run({ path: ".env", content: MASKED }, ctx())).rejects.toThrow(/masked secret/);
    await expect(
      tool.run({ path: ".env", content: "X_TOKEN=[redacted:secret]\n", mode: "append" }, ctx()),
    ).rejects.toThrow(/masked secret/);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(ENV);
    expect(asked).toBe(0);
  });

  it("os.fs.edit", async () => {
    const tool = buildOsFsEditTool({ approvals: gate(), approvalRequired: true });
    await expect(
      tool.run({ path: ".env", oldString: "LOG_LEVEL=info", newString: "LOG_LEVEL=debug\nA_KEY=[redacted:api-key]" }, ctx()),
    ).rejects.toThrow(/masked secret/);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(ENV);
    expect(asked).toBe(0);
  });

  it("os.fs.edit around the secret line still works", async () => {
    const tool = buildOsFsEditTool({ approvals: gate(), approvalRequired: true });
    const result = await tool.run({ path: ".env", oldString: "LOG_LEVEL=info", newString: "LOG_LEVEL=debug" }, ctx());
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(ENV.replace("info", "debug"));
  });

  it("os.fs.patch", async () => {
    const tool = buildOsFsPatchTool({ approvals: gate(), approvalRequired: true });
    const patch = createPatch(".env", ENV, MASKED);
    await expect(tool.run({ patch, apply: true }, ctx())).rejects.toThrow(/masked secret/);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(ENV);
    expect(asked).toBe(0);
  });
});
