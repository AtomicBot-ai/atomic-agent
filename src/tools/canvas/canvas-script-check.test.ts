import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { checkPageScripts, scriptProblemsText, SCRIPT_PROBLEMS_MAX } from "./canvas-script-check.js";
import { buildCanvasRenderTool } from "./index.js";

describe("checkPageScripts (ATO-2457)", () => {
  it("passes a page whose scripts parse, and leaves modules, JSON and templates alone", () => {
    const page = [
      "<div id=a></div>",
      "<script>const a = document.getElementById('a'); a.textContent = `hi ${1 + 1}`;</script>",
      "<script type=\"module\">import x from './x.js'; export default x;</script>",
      "<script type=\"application/json\">{ not js</script>",
      "<script type=\"text/template\"><b>{{ name }}</b></script>",
    ].join("\n");
    expect(checkPageScripts(page)).toEqual([]);
  });

  it("names the script and the page line of a syntax error", () => {
    const page = ["<h1>Calc</h1>", "<script>", "let x = 1;", "function add( {", "}", "</script>"].join("\n");
    const [p] = checkPageScripts(page);
    expect(p).toMatchObject({ script: 1, line: 4 });
    expect(p!.message).toMatch(/^SyntaxError: /);
    expect(scriptProblemsText([p!])).toContain("- script 1 (page line 4): SyntaxError");
  });

  it("reports a script loaded from a CDN, since the page has no network", () => {
    const [p] = checkPageScripts('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>');
    expect(p!.message).toContain("no network");
    expect(p!.message).toContain("cdn.jsdelivr.net");
  });

  it("stops after a few problems", () => {
    const page = Array.from({ length: 6 }, () => "<script>(</script>").join("");
    expect(checkPageScripts(page)).toHaveLength(SCRIPT_PROBLEMS_MAX);
  });

  it("never runs the script it checks", () => {
    const g = globalThis as { __ranCanvasScript?: boolean };
    checkPageScripts("<script>globalThis.__ranCanvasScript = true;</script>");
    expect(g.__ranCanvasScript).toBeUndefined();
  });
});

describe("canvas.render with a broken script", () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), "canvas-script-")); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });
  const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

  it("fails with the problem for the model to fix, asks nothing and writes no file", async () => {
    const tool = buildCanvasRenderTool({
      approvals: new ApprovalGate({ emit: () => { throw new Error("no prompt expected"); } }),
      approvalRequired: true,
    });
    const result = await tool.run({ title: "Calc", html: "<button onclick=go()>Go</button><script>function go( { }</script>" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("canvas.render: the page's script has a problem");
    expect(result.summary).toContain("script 1 (page line 1)");
    expect(result.summary).toContain("call canvas.render again");
    expect(readdirSync(work)).toEqual([]);
  });
});
