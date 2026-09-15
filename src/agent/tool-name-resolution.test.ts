import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/tool-registry.js";
import { resolveToolName } from "./tool-name-resolution.js";

function registry(...names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) {
    reg.register({
      name,
      description: name,
      readonly: true,
      run: async () => ({
        tool: name,
        status: "ok" as const,
        summary: "",
        details: {},
        truncated: false,
      }),
    });
  }
  return reg;
}

const REG = registry(
  "fusion.delegate",
  "os.fs.write",
  "os.fs.trash",
  "reply",
);

describe("resolveToolName", () => {
  it("returns an exact name untouched", () => {
    expect(resolveToolName("os.fs.write", REG)).toBe("os.fs.write");
    expect(resolveToolName("reply", REG)).toBe("reply");
  });

  it("fixes the separator a model got one underscore short", () => {
    // The observed failure: `fusion.delegate` travels the OpenAI wire as
    // `fusion__delegate`, the model wrote it from memory as
    // `fusion_delegate`, and the turn died on the membership check.
    expect(resolveToolName("fusion_delegate", REG)).toBe("fusion.delegate");
    expect(resolveToolName("os_fs_write", REG)).toBe("os.fs.write");
  });

  it("resolves a name that arrived still escaped", () => {
    // The text-JSON fallback path does not run `nameUnescape`.
    expect(resolveToolName("fusion__delegate", REG)).toBe("fusion.delegate");
  });

  it("resolves case on its own and over a fixed separator", () => {
    expect(resolveToolName("OS.FS.WRITE", REG)).toBe("os.fs.write");
    expect(resolveToolName("Fusion_Delegate", REG)).toBe("fusion.delegate");
  });

  it("refuses to guess between near neighbours", () => {
    // Not fuzzy matching. `os.fs.write` must never resolve to
    // `os.fs.trash` because the two are close — a tool that deletes is
    // one edit away from a tool that writes.
    expect(resolveToolName("os.fs.writ", REG)).toBeNull();
    expect(resolveToolName("os.fs.wrote", REG)).toBeNull();
    expect(resolveToolName("fs.write", REG)).toBeNull();
  });

  it("returns null for a name that is nothing like a registered tool", () => {
    expect(resolveToolName("summon_daemon", REG)).toBeNull();
    expect(resolveToolName("", REG)).toBeNull();
  });
});
