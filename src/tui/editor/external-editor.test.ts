import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEditorInvocation,
  editInExternalEditor,
  normalizeEditedText,
  resolveEditor,
  type ExternalEditorDeps,
  type SpawnEditor,
} from "./external-editor.js";

describe("resolveEditor", () => {
  it("prefers VISUAL over EDITOR", () => {
    expect(resolveEditor({ VISUAL: "code --wait", EDITOR: "vim" }, "darwin")).toEqual({
      command: "code --wait",
      source: "VISUAL",
    });
  });

  it("falls back to EDITOR and ignores a blank VISUAL", () => {
    expect(resolveEditor({ VISUAL: "  ", EDITOR: " nano " }, "linux")).toEqual({
      command: "nano",
      source: "EDITOR",
    });
  });

  it("uses Notepad on Windows when neither is set", () => {
    expect(resolveEditor({}, "win32")).toEqual({ command: "notepad", source: "fallback" });
  });

  it("returns null elsewhere when neither is set", () => {
    expect(resolveEditor({}, "darwin")).toBeNull();
    expect(resolveEditor({}, "linux")).toBeNull();
  });
});

describe("buildEditorInvocation", () => {
  it("runs the variable through sh with the path as $1, never spliced in", () => {
    const inv = buildEditorInvocation({ command: "code --wait", source: "VISUAL" }, "/tmp/a b/prompt.md", "darwin");
    expect(inv).toEqual({
      file: "/bin/sh",
      args: ["-c", 'code --wait "$@"', "sh", "/tmp/a b/prompt.md"],
      shell: false,
    });
  });

  it("quotes the path into one cmd line on Windows", () => {
    const inv = buildEditorInvocation({ command: "notepad", source: "fallback" }, "C:\\Temp\\x\\prompt.md", "win32");
    expect(inv).toEqual({ file: 'notepad "C:\\Temp\\x\\prompt.md"', args: [], shell: true });
  });
});

describe("normalizeEditedText", () => {
  it("drops the final newline editors add, CRLF and a BOM", () => {
    expect(normalizeEditedText("\uFEFFline one\r\nline two\r\n\r\n")).toBe("line one\nline two");
  });

  it("keeps inner blank lines and leading space", () => {
    expect(normalizeEditedText("  a\n\nb\n")).toBe("  a\n\nb");
  });
});

describe("editInExternalEditor", () => {
  let tmp: string;
  let events: string[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ext-editor-test-"));
    events = [];
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** The temp file the editor was pointed at: the last argument on POSIX. */
  const fileOf = (args: readonly string[]): string => args[args.length - 1] ?? "";

  function deps(spawn: SpawnEditor, env: NodeJS.ProcessEnv = { EDITOR: "fake-editor" }): ExternalEditorDeps {
    return {
      env,
      platform: "linux",
      tmpDir: tmp,
      spawn: (file, args, options) => {
        events.push("spawn");
        return spawn(file, args, options);
      },
      terminal: {
        suspend: () => events.push("suspend"),
        resume: () => events.push("resume"),
      },
    };
  }

  it("round-trips the draft through the file and returns the saved text", () => {
    let seen = "";
    let path = "";
    const result = editInExternalEditor(
      "first draft",
      deps((_file, args, options) => {
        path = fileOf(args);
        seen = readFileSync(path, "utf8");
        expect(options.stdio).toBe("inherit");
        writeFileSync(path, "first draft\nwith a second line\n");
        return { status: 0, signal: null };
      }),
    );
    expect(seen).toBe("first draft");
    expect(result).toEqual({ kind: "edited", text: "first draft\nwith a second line", editor: "fake-editor" });
    expect(events).toEqual(["suspend", "spawn", "resume"]);
    // The temp dir is gone afterwards, file and all.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("reports an unchanged prompt when only a final newline was added", () => {
    const result = editInExternalEditor(
      "same",
      deps((_file, args) => {
        writeFileSync(fileOf(args), "same\n");
        return { status: 0, signal: null };
      }),
    );
    expect(result).toEqual({ kind: "unchanged", editor: "fake-editor" });
  });

  it("says no editor is set without touching the terminal", () => {
    const result = editInExternalEditor("x", deps(() => ({ status: 0, signal: null }), {}));
    expect(result).toEqual({ kind: "no-editor" });
    expect(events).toEqual([]);
  });

  it("keeps the prompt and explains a missing editor binary", () => {
    const result = editInExternalEditor("x", deps(() => ({ status: 127, signal: null })));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message).toContain("editor not found: fake-editor");
    expect(events).toEqual(["suspend", "spawn", "resume"]);
  });

  it("ignores what was saved when the editor exits non-zero", () => {
    const result = editInExternalEditor(
      "x",
      deps((_file, args) => {
        writeFileSync(fileOf(args), "half-written\n");
        return { status: 1, signal: null };
      }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message).toContain("exited with code 1");
  });

  it("reports a spawn error and still restores the terminal", () => {
    const result = editInExternalEditor(
      "x",
      deps(() => ({ status: null, signal: null, error: new Error("spawn /bin/sh ENOENT") })),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message).toContain("ENOENT");
    expect(events).toEqual(["suspend", "spawn", "resume"]);
  });

  it("restores the terminal and cleans up even when spawn throws", () => {
    let path = "";
    const result = editInExternalEditor(
      "x",
      deps((_file, args) => {
        path = fileOf(args);
        throw new Error("boom");
      }),
    );
    expect(result).toEqual({ kind: "failed", message: "external editor failed: boom" });
    expect(events).toEqual(["suspend", "spawn", "resume"]);
    expect(existsSync(dirname(path))).toBe(false);
  });
});
