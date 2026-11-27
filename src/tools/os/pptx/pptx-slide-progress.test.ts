import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { layoutSlide } from "./pptx-layout.js";
import {
  THUMB_BULLETS,
  THUMB_CHARS,
  slideProgressLabel,
  slideProgressOf,
  slideReporter,
  type PptxProgressUpdate,
} from "./pptx-slide-progress.js";
import { parseBullet, type PptxDeckSpec, type PptxSlideSpec } from "./pptx-spec.js";
import { buildOsFsWritePptxTool } from "./write-pptx-tool.js";

/** ATO-2444: each slide of a deck, as it is laid out, for the chat to draw small. */
const deck = (slides: PptxSlideSpec[]): Pick<PptxDeckSpec, "slides" | "theme" | "accentColor"> => ({
  slides,
  theme: "dark",
  accentColor: "2F6FEB",
});
const slide = (over: Partial<Omit<PptxSlideSpec, "bullets">> & { bullets?: string[] } = {}): PptxSlideSpec => {
  const { bullets = [], ...rest } = over;
  return { title: "Topic", ...rest, bullets: bullets.map(parseBullet) };
};

describe("slideProgressOf", () => {
  it("names the slide's place, layout, theme and clipped text", () => {
    const long = "word ".repeat(40);
    const s = slide({ title: `Goals ${long}`, subtitle: "For Q3", bullets: ["One", "  Sub", ...Array(10).fill("More")] });
    const p = slideProgressOf(layoutSlide(s), 1, deck([slide(), s]));
    expect(p).toMatchObject({ index: 1, count: 2, layout: "two-column", subtitle: "For Q3", theme: "dark", accent: "2F6FEB", moved: 0 });
    expect(p.title.length).toBeLessThanOrEqual(THUMB_CHARS);
    expect(p.title.endsWith("…")).toBe(true);
    expect(p.bullets).toHaveLength(THUMB_BULLETS);
    expect(p.bullets.slice(0, 2)).toEqual(["One", "  Sub"]);
    expect(p).not.toHaveProperty("visual");
  });

  it("says which visual a slide carries and how many bullets went to the notes", () => {
    const chart = { type: "column" as const, categories: ["Q1"], series: [{ name: "EU", values: [1] }] };
    const p = slideProgressOf(layoutSlide(slide({ chart, bullets: ["a", "b", "c", "d", "e", "f"] })), 0, deck([slide()]));
    expect(p.visual).toBe("chart");
    expect(p.moved).toBeGreaterThan(0);
    expect(slideProgressOf(layoutSlide(slide({ table: [["A"], ["1"]] })), 0, deck([slide()])).visual).toBe("table");
    expect(slideProgressLabel(p)).toBe(`Slide 1 of 1 (${p.layout}): Topic`);
  });
});

describe("slideReporter", () => {
  it("is undefined without a sink, and a sink that throws never fails the build", () => {
    expect(slideReporter(undefined, "s", deck([slide()]), Date.now())).toBeUndefined();
    const report = slideReporter(() => { throw new Error("host gone"); }, "s", deck([slide()]), Date.now())!;
    expect(() => report(layoutSlide(slide()), 0)).not.toThrow();
  });
});

describe("os.fs.write_pptx: onProgress", () => {
  let dir: string;
  let gate: ApprovalGate;
  let prompts: ApprovalRequest[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pptx-progress-"));
    prompts = [];
    gate = new ApprovalGate({
      level: 1,
      emit: (request) => {
        prompts.push(request);
        queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: true }));
      },
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (): ToolContext => ({ workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal });

  it("reports every slide in order, before the approval prompt is raised", async () => {
    const seen: { sessionId: string; update: PptxProgressUpdate; promptsSoFar: number }[] = [];
    const tool = buildOsFsWritePptxTool({
      approvals: gate,
      approvalRequired: true,
      onProgress: (sessionId, update) => seen.push({ sessionId, update, promptsSoFar: prompts.length }),
    });
    const result = await tool.run(
      { path: "plan.pptx", slides: [{ title: "Plan", subtitle: "Team" }, { title: "Goals", bullets: ["Ship"] }, { title: "42%" }] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(seen.map((s) => s.update.slide.index)).toEqual([0, 1, 2]);
    expect(seen.map((s) => s.update.slide.layout)).toEqual(["title", "bullets", "big-number"]);
    expect(seen.every((s) => s.sessionId === "s-p" && s.promptsSoFar === 0)).toBe(true);
    expect(seen.map((s) => s.update.fraction)).toEqual([1 / 3, 2 / 3, 1]);
    expect(seen[1]!.update.label).toBe("Slide 2 of 3 (bullets): Goals");
  });

  it("reports nothing for a deck refused before it is built", async () => {
    const seen: unknown[] = [];
    const tool = buildOsFsWritePptxTool({ approvals: gate, approvalRequired: true, onProgress: (_s, u) => seen.push(u) });
    await expect(tool.run({ path: "bad.txt", slides: [{ title: "x" }] }, ctx())).rejects.toThrow(/\.pptx/);
    expect(seen).toEqual([]);
  });
});
