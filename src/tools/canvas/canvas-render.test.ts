import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { buildCanvasRenderTool, canvasRecordOf, canvasSlug, CANVAS_RENDER_TOOL } from "./index.js";

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "canvas-render-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });
const NOW = () => new Date(2026, 10, 12, 14, 22, 33);
/** Approval off, as with the gate disabled: the drawing tests are about the page. */
const tool = () => buildCanvasRenderTool({
  approvals: new ApprovalGate({ emit: () => { throw new Error("no prompt expected"); } }),
  approvalRequired: false,
  now: NOW,
});

describe("canvas.render (ATO-1137)", () => {
  it("draws a bar chart into a new self-contained HTML file in the working folder", async () => {
    const result = await tool().run({
      title: "Revenue by quarter",
      chart: "bar",
      labels: ["Q1", "Q2", "Q3", "Q4"],
      series: [{ name: "2025", values: [120, 135, 150, 170] }, { name: "2026", values: [140, 160, 155, 190] }],
    }, ctx());

    expect(result.status).toBe("ok");
    const path = join(work, "canvas-revenue-by-quarter-20261112-142233.html");
    expect(result.details?.canvas).toEqual({ path, title: "Revenue by quarter", kind: "chart", chart: "bar", bytes: expect.any(Number) });
    const page = readFileSync(path, "utf8");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<svg");
    // 2 series x 4 labels, each bar with its value on hover.
    expect(page.match(/<rect class="mark"/g)).toHaveLength(8);
    expect(page).toContain("<title>Q4 · 2026: 190</title>");
    // Two series get a legend, and the numbers are in a table too.
    expect(page).toContain('class="legend"');
    expect(page).toContain("<td>155</td>");
    // Nothing loaded from the network.
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    expect(result.summary).toContain(path);
  });

  it("takes a single `values` list, numbers sent as strings, and draws line, area and pie", async () => {
    for (const chart of ["line", "area", "pie"] as const) {
      const result = await tool().run({ title: `Disk ${chart}`, chart, labels: ["Photos", "Code", "Other"], values: ["52", "1,031", "17%"] }, ctx());
      expect(result.status, chart).toBe("ok");
      const page = readFileSync((result.details!.canvas as { path: string }).path, "utf8");
      expect(page).toContain("<td>1,031</td>");
      if (chart === "pie") expect(page.match(/<path class="mark"/g)).toHaveLength(3);
      else expect(page.match(/<circle class="mark"/g)).toHaveLength(3);
    }
  });

  it("a table chart is the numbers only", async () => {
    const result = await tool().run({ title: "Scores", chart: "table", labels: ["a", "b"], values: [1, 2] }, ctx());
    const page = readFileSync((result.details!.canvas as { path: string }).path, "utf8");
    expect(page).not.toContain("<svg");
    expect(page).toContain("<table>");
  });

  it("escapes labels, names and titles: data cannot inject markup", async () => {
    const result = await tool().run({
      title: "<script>alert(1)</script>",
      chart: "bar",
      labels: ['<img src=x onerror="alert(1)">'],
      series: [{ name: "</title><script>", values: [1] }],
    }, ctx());
    const page = readFileSync((result.details!.canvas as { path: string }).path, "utf8");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("wraps an HTML fragment in the page frame and keeps a whole document as it is", async () => {
    const fragment = await tool().run({ title: "Notes", html: "<p>Hello</p>", name: "My notes" }, ctx());
    expect(fragment.details?.canvas).toMatchObject({ kind: "html", title: "Notes" });
    const fragmentPath = (fragment.details!.canvas as { path: string }).path;
    expect(fragmentPath).toBe(join(work, "canvas-my-notes-20261112-142233.html"));
    const wrapped = readFileSync(fragmentPath, "utf8");
    expect(wrapped).toContain("<h1>Notes</h1>");
    expect(wrapped).toContain("<p>Hello</p>");

    const doc = "<!DOCTYPE html><html><body><canvas id=c></canvas><script>1</script></body></html>";
    const whole = await tool().run({ title: "Game", html: doc }, ctx());
    expect(readFileSync((whole.details!.canvas as { path: string }).path, "utf8")).toBe(doc);
  });

  it("never overwrites: a second canvas with the same name in the same second gets -2", async () => {
    const existing = join(work, "canvas-sales-20261112-142233.html");
    writeFileSync(existing, "mine");
    const result = await tool().run({ title: "Sales", chart: "bar", labels: ["a"], values: [1] }, ctx());
    expect((result.details!.canvas as { path: string }).path).toBe(join(work, "canvas-sales-20261112-142233-2.html"));
    expect(readFileSync(existing, "utf8")).toBe("mine");
  });

  it("refuses bad args with a sentence the model can act on, and writes nothing", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ chart: "bar", labels: ["a"], values: [1] }, /`title`/],
      [{ title: "x" }, /pass `html`/],
      [{ title: "x", html: "<p>", chart: "bar" }, /not both/],
      [{ title: "x", chart: "radar", labels: ["a"], values: [1] }, /"radar" is not supported/],
      [{ title: "x", chart: "bar", labels: [], values: [] }, /`labels`/],
      [{ title: "x", chart: "bar", labels: ["a", "b"], values: [1] }, /one value per label/],
      [{ title: "x", chart: "bar", labels: ["a"], values: ["lots"] }, /not a number/],
      [{ title: "x", chart: "bar", labels: ["a"] }, /needs its numbers/],
      [{ title: "x", chart: "bar", labels: ["a"], series: Array.from({ length: 9 }, () => ({ name: "s", values: [1] })) }, /at most 8 series/],
    ];
    for (const [args, message] of cases) {
      const result = await tool().run(args, ctx());
      expect(result.status, JSON.stringify(args)).toBe("error");
      expect(result.summary).toMatch(message);
    }
    expect(readdirSync(work)).toEqual([]);
  });

  it("canvasSlug keeps file names plain", () => {
    expect(canvasSlug("Quarterly revenue (2026)")).toBe("quarterly-revenue-2026");
    expect(canvasSlug("Café ünïcode")).toBe("cafe-unicode");
    expect(canvasSlug("Выручка")).toBe("canvas");
    expect(canvasSlug("a".repeat(80)).length).toBe(48);
  });
});

describe("canvas.render approval (ATO-1137 review)", () => {
  /** A gate at level 1 (asks on every workspace write) that records and answers each prompt. */
  function gate(approved: boolean) {
    const asked: ApprovalRequest[] = [];
    const approvals: ApprovalGate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        if (approved) approvals.resolve({ approvalId: req.approvalId, approved: true });
        else approvals.reject(req.approvalId, "denied by test");
      },
    });
    const registry = new ToolRegistry();
    registry.register(buildCanvasRenderTool({ approvals, approvalRequired: true, now: NOW }));
    return { asked, registry };
  }
  const args = { title: "Sales", chart: "bar", labels: ["a"], values: [1] };

  it("asks through the fs-write funnel at the strictest level and writes nothing on a no", async () => {
    const { asked, registry } = gate(false);
    await expect(registry.invoke(CANVAS_RENDER_TOOL, args, ctx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: CANVAS_RENDER_TOOL, category: "fs_write_workspace" });
    expect(readdirSync(work)).toEqual([]);
  });

  it("writes the file once the write is approved", async () => {
    const { asked, registry } = gate(true);
    const result = await registry.invoke(CANVAS_RENDER_TOOL, args, ctx());
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(1);
    expect(readdirSync(work)).toEqual(["canvas-sales-20261112-142233.html"]);
  });
});

describe("canvasRecordOf", () => {
  const ok = (details: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({ tool: CANVAS_RENDER_TOOL, status: "ok", summary: "", truncated: false, details, ...over }) as never;
  const canvas = { path: "/w/canvas-a.html", title: "A", kind: "chart", chart: "pie", bytes: 10 };

  it("reads an ok canvas.render's record and nothing else", () => {
    expect(canvasRecordOf(ok({ canvas }))).toEqual(canvas);
    expect(canvasRecordOf(ok({ canvas }, { status: "error" }))).toBeUndefined();
    expect(canvasRecordOf(ok({ canvas }, { tool: "os.fs.write" }))).toBeUndefined();
    expect(canvasRecordOf(ok({}))).toBeUndefined();
    expect(canvasRecordOf(ok({ canvas: { ...canvas, path: "" } }))).toBeUndefined();
    expect(canvasRecordOf(ok({ canvas: { ...canvas, kind: "svg" } }))).toBeUndefined();
    // An unknown chart type is dropped, the canvas still opens.
    expect(canvasRecordOf(ok({ canvas: { ...canvas, chart: "radar" } }))).toEqual({ path: canvas.path, title: "A", kind: "chart", bytes: 10 });
  });
});
