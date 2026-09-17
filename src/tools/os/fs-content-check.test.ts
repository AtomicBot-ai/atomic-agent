import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import {
  checkChangedFile,
  checkWrittenContent,
  DOUBLE_ESCAPE_MIN_LITERALS,
  newContentWarnings,
} from "./fs-content-check.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsWriteTool } from "./fs-write.js";

const PAGE = [
  "<!doctype html>",
  "<html>",
  "<head><title>t</title></head>",
  "<body>",
  '<script type="module">import { a } from "./a.js"; export const b = {</script>',
  '<script type="application/json">{"not": "js"</script>',
  '<script src="js/main.js"></script>',
  "<script>",
  "  window.HD = {",
  "    init() {",
  "      return 1;",
  "    },",
  "</script>",
  "</body>",
  "</html>",
].join("\n");

/** The same page with the inline script closed: nothing to warn about. */
const PAGE_OK = PAGE.replace("    },\n</script>", "    },\n  };\n</script>");

describe("checkWrittenContent — HTML", () => {
  it("parses inline classic scripts and reports the line in the file", () => {
    const warnings = checkWrittenContent("/w/index.html", PAGE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "html_script", key: "script4" });
    // The block opens on line 8; the unclosed object is reported at its
    // end, line 13 in the file — not line 6 inside the block.
    expect(warnings[0]!.message).toBe(
      "inline <script> #4 does not parse: SyntaxError: Unexpected end of input (line 13)",
    );
  });

  it("skips module, non-JS and external scripts, and a script that parses", () => {
    expect(checkWrittenContent("/w/index.html", PAGE_OK)).toEqual([]);
  });

  it("warns on content after </html>, counting it and naming the line", () => {
    const junk = `${PAGE_OK}\n\nassistant_tool_call: {"tool":"reply"}\nmore junk\n`;
    const warnings = checkWrittenContent("/w/page.htm", junk);
    const trailing = warnings.find((w) => w.kind === "html_trailing");
    expect(trailing).toBeDefined();
    expect(trailing!.count).toBe(junk.length - PAGE_OK.length);
    expect(trailing!.message).toMatch(
      /^\d+ chars of content after <\/html> \(from line 16\)/,
    );
    // The same junk is transcript markup too — both are said.
    expect(warnings.map((w) => w.kind)).toEqual([
      "html_trailing",
      "transcript_markup",
    ]);
  });

  it("ignores whitespace after </html> and non-HTML files", () => {
    expect(checkWrittenContent("/w/index.html", `${PAGE_OK}\n\n  \n`)).toEqual([]);
    expect(checkWrittenContent("/w/notes.txt", `${PAGE_OK}\njunk`)).toEqual([]);
  });
});

describe("checkWrittenContent — any text", () => {
  it.each([
    "assistant_tool_call:",
    "tool_result[",
    "<|channel|>",
    "<|turn>",
  ])("flags a line starting with %s", (marker) => {
    const content = `const a = 1;\n${marker} x\nconst b = 2;\n${marker} y\n`;
    const [warning] = checkWrittenContent("/w/a.js", content);
    expect(warning).toMatchObject({
      kind: "transcript_markup",
      key: marker,
      count: 2,
    });
    expect(warning!.message).toBe(
      `line 2 and 1 more line(s) starts with \`${marker}\` — that is agent transcript markup, not file content; remove it`,
    );
  });

  it("does not flag the markers mid-line", () => {
    expect(
      checkWrittenContent("/w/a.md", "see assistant_tool_call: and tool_result[ here\n"),
    ).toEqual([]);
  });

  it("flags double-escaped content: more literal \\n than real newlines", () => {
    const literal = "function f() {\\n  return 1;\\n}\\n\\nf();\\n";
    const [warning] = checkWrittenContent("/w/game.js", literal);
    expect(warning).toMatchObject({ kind: "double_escaped", count: 5 });
    expect(warning!.message).toBe(
      "5 literal \\n sequences but 0 real newline(s) — the content looks escaped twice; write it with real newlines",
    );
  });

  it("tolerates a few literal \\n in real source, and an escaped backslash", () => {
    const source = 'const sep = "\\n";\nconst re = /\\n\\n/;\nconst path = "C:\\\\new";\n';
    expect(checkWrittenContent("/w/a.js", source)).toEqual([]);
    const fewer = Array.from({ length: DOUBLE_ESCAPE_MIN_LITERALS - 1 }, () => "\\n").join("");
    expect(checkWrittenContent("/w/a.txt", fewer)).toEqual([]);
  });
});

describe("newContentWarnings", () => {
  const junkPage = `${PAGE_OK}\njunk`;

  it("reports only what the change introduced or made worse", () => {
    expect(newContentWarnings("/w/i.html", junkPage, junkPage)).toEqual([]);
    expect(
      newContentWarnings("/w/i.html", junkPage, `${junkPage}\nmore junk`).map(
        (w) => w.kind,
      ),
    ).toEqual(["html_trailing"]);
    expect(newContentWarnings("/w/i.html", PAGE_OK, junkPage).map((w) => w.kind)).toEqual([
      "html_trailing",
    ]);
  });

  it("reports everything for a brand-new file", () => {
    expect(newContentWarnings("/w/i.html", undefined, junkPage)).toHaveLength(1);
  });
});

describe("checkChangedFile", () => {
  it("puts the parse warning first, then one line per content warning", () => {
    const out = checkChangedFile({
      absolute: "/w/js/a.js",
      workingDir: "/w",
      change: "write",
      after: "assistant_tool_call: {}\nconst o = {\n",
    });
    expect(out!.split("\n")).toEqual([
      "⚠ js/a.js does not parse: SyntaxError: Unexpected end of input (line 3)",
      "⚠ js/a.js: line 1 starts with `assistant_tool_call:` — that is agent transcript markup, not file content; remove it",
    ]);
  });

  it("is null when there is nothing to say", () => {
    expect(
      checkChangedFile({
        absolute: "/w/a.txt",
        workingDir: "/w",
        change: "write",
        after: "hello\n",
      }),
    ).toBeNull();
  });
});

describe("os.fs.write / os.fs.edit content warnings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-content-check-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function approveAll(): ApprovalGate {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return gate;
  }

  function makeCtx(): ToolContext {
    return {
      workingDir: dir,
      sessionId: "s",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  const options = () => ({ approvals: approveAll(), approvalRequired: true });

  it("writes an HTML file with junk after </html> and says so, without blocking", async () => {
    const content = `${PAGE.replace("</html>", "</html>\n")}tool_result[os.fs.write]: ok\n`;
    const result = await buildOsFsWriteTool(options()).run(
      { path: "index.html", content },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(content);
    const lines = result.summary.split("\n");
    expect(lines[0]).toMatch(
      /^⚠ index\.html: inline <script> #4 does not parse: SyntaxError: /,
    );
    expect(lines[1]).toMatch(/^⚠ index\.html: \d+ chars of content after <\/html>/);
    expect(lines[2]).toMatch(/^⚠ index\.html: line 16 starts with `tool_result\[`/);
    expect(lines[3]).toMatch(/^wrote /);
    expect(result.details.parseWarning).toBe(lines.slice(0, 3).join("\n"));
  });

  it("flags a double-escaped script write", async () => {
    const result = await buildOsFsWriteTool(options()).run(
      { path: "game.js", content: "const a = 1;\\nconst b = 2;\\nconst c = 3;\\nconst d = 4;\\n" },
      makeCtx(),
    );
    // The parse check speaks first (a literal `\n` is not JS); the
    // escaping warning names the actual mistake right after it.
    const lines = result.summary.split("\n");
    expect(lines[0]).toMatch(/^⚠ game\.js does not parse: /);
    expect(lines[1]).toBe(
      "⚠ game.js: 4 literal \\n sequences but 0 real newline(s) — the content looks escaped twice; write it with real newlines",
    );
  });

  it("an edit that leaves an old problem alone is not warned again; one that adds junk is", async () => {
    await writeFile(join(dir, "index.html"), `${PAGE}\nold junk\n`, "utf8");
    const edit = buildOsFsEditTool(options());
    const quiet = await edit.run(
      { path: "index.html", oldString: "<title>t</title>", newString: "<title>u</title>" },
      makeCtx(),
    );
    expect(quiet.details.parseWarning).toBeUndefined();
    const loud = await edit.run(
      { path: "index.html", oldString: "old junk", newString: "old junk\nassistant_tool_call: {}" },
      makeCtx(),
    );
    expect(loud.details.parseWarning).toContain("starts with `assistant_tool_call:`");
    expect(loud.details.parseWarning).toContain("chars of content after </html>");
  });
});
