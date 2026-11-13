import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { DeclaredInputsRegistry } from "../fs/fs-declared-inputs.js";
import { buildOsFsRestoreTool } from "../fs/fs-restore.js";
import { FileRestoreStore } from "../fs/fs-restore-store.js";
import { buildOsFsWriteTool } from "../fs/fs-write.js";
import { buildOsFsReadDocumentTool } from "../read-document/index.js";
import { buildOsFsWritePptxTool } from "./write-pptx-tool.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let gate: ApprovalGate;
let prompts: ApprovalRequest[];
let answers: Omit<ApprovalDecision, "approvalId">[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "write-pptx-"));
  prompts = [];
  answers = [];
  gate = new ApprovalGate({
    level: 1,
    emit: (request) => {
      prompts.push(request);
      const answer = answers.shift() ?? { approved: true };
      queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, ...answer }));
    },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workingDir: dir,
  sessionId: "s-pptx",
  stepIndex: 0,
  signal: new AbortController().signal,
});

const tool = () => buildOsFsWritePptxTool({ approvals: gate, approvalRequired: true });

const SLIDES = [
  { title: "Launch plan", subtitle: "Atomic team" },
  { title: "Goals", bullets: ["Ship the beta", "  Collect feedback"], notes: "Keep it short." },
];

describe("os.fs.write_pptx", () => {
  it("writes a deck after one approval, and os.fs.read_document reads it back", async () => {
    const result = await tool().run({ path: "decks/plan.pptx", slides: SLIDES }, ctx());
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.tool).toBe("os.fs.write_pptx");
    expect(prompts[0]!.preview).toContain("1. Launch plan");
    expect(prompts[0]!.preview).toContain("2. Goals (2 bullets, notes)");
    expect(result.details).toMatchObject({ slides: 2, notes: 1, images: 0, replaced: false, theme: "light" });
    expect(result.summary).toContain("Created");

    const target = join(dir, "decks/plan.pptx");
    expect(existsSync(target)).toBe(true);
    // No temp file is left beside it.
    expect(await readdir(join(dir, "decks"))).toEqual(["plan.pptx"]);

    const read = await buildOsFsReadDocumentTool().run({ path: "decks/plan.pptx" }, ctx());
    expect(read.status).toBe("ok");
    const full = read.fullOutput ?? read.summary;
    expect(full).toContain("Launch plan");
    expect(full).toContain("Collect feedback");
    expect(read.details.slideCount).toBe(2);
  });

  it("refuses to replace an existing file without overwrite, before asking", async () => {
    await writeFile(join(dir, "old.pptx"), "keep me");
    await expect(tool().run({ path: "old.pptx", slides: SLIDES }, ctx())).rejects.toThrow(/already exists; pass overwrite: true/);
    expect(prompts).toHaveLength(0);
    expect(await readFile(join(dir, "old.pptx"), "utf8")).toBe("keep me");
  });

  it("replaces an existing file with overwrite: true, naming the replace in the prompt", async () => {
    await writeFile(join(dir, "old.pptx"), "keep me");
    const result = await tool().run({ path: "old.pptx", slides: SLIDES, overwrite: true }, ctx());
    expect(result.details.replaced).toBe(true);
    expect(prompts[0]!.reason).toMatch(/^replace a 2-slide PowerPoint deck/);
    const zip = await JSZip.loadAsync(await readFile(join(dir, "old.pptx")));
    expect(zip.file("ppt/presentation.xml")).not.toBeNull();
  });

  it("writes nothing when the operator says no", async () => {
    answers.push({ approved: false });
    await expect(tool().run({ path: "no.pptx", slides: SLIDES }, ctx())).rejects.toThrow();
    expect(existsSync(join(dir, "no.pptx"))).toBe(false);
  });

  it("embeds a picture from disk next to the bullets", async () => {
    await writeFile(join(dir, "chart.png"), PNG_1X1);
    const result = await tool().run(
      { path: "pic.pptx", slides: [{ title: "Chart", bullets: ["Up and to the right"], image: "chart.png" }] },
      ctx(),
    );
    expect(result.details.images).toBe(1);
    const zip = await JSZip.loadAsync(await readFile(join(dir, "pic.pptx")));
    const media = zip.file("ppt/media/image1.png");
    expect(media).not.toBeNull();
    expect(Buffer.from(await media!.async("uint8array")).equals(PNG_1X1)).toBe(true);
  });

  it("refuses a missing picture or a file that is not a picture, before asking", async () => {
    await expect(
      tool().run({ path: "a.pptx", slides: [{ title: "T", image: "nope.png" }] }, ctx()),
    ).rejects.toThrow(/slides\[0\]\.image: no picture at nope\.png/);
    await writeFile(join(dir, "logo.svg"), "<svg/>");
    await expect(
      tool().run({ path: "a.pptx", slides: [{ title: "T", image: "logo.svg" }] }, ctx()),
    ).rejects.toThrow(/not a PNG, JPEG or GIF/);
    expect(prompts).toHaveLength(0);
    expect(existsSync(join(dir, "a.pptx"))).toBe(false);
  });

  it("refuses a folder as the target", async () => {
    await mkdir(join(dir, "folder.pptx"));
    await expect(tool().run({ path: "folder.pptx", slides: SLIDES, overwrite: true }, ctx())).rejects.toThrow(/is a folder/);
  });

  describe("replacing a deck the user handed in", () => {
    let stateDir: string;
    let store: FileRestoreStore;
    let auto: ApprovalGate;
    let autoPrompts: ApprovalRequest[];

    beforeEach(async () => {
      stateDir = await mkdtemp(join(tmpdir(), "write-pptx-state-"));
      store = new FileRestoreStore(join(stateDir, "restore"));
      autoPrompts = [];
      // Auto-approve: at level 5 a workspace write approves itself, so
      // only the input guard stands between the call and the user's deck.
      auto = new ApprovalGate({
        level: 5,
        emit: (request) => {
          autoPrompts.push(request);
          queueMicrotask(() => auto.resolve({ approvalId: request.approvalId, approved: true }));
        },
      });
    });

    afterEach(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const request = "Tighten talk.pptx: shorter bullets, same slides";

    it("refuses overwrite: true on a deck the request names, like os.fs.write", async () => {
      const original = Buffer.from("PK\u0003\u0004 the user's talk");
      await writeFile(join(dir, "talk.pptx"), original);
      const options = {
        approvals: auto,
        approvalRequired: true,
        restore: store,
        resolveOriginalRequest: () => request,
      };
      const result = await buildOsFsWritePptxTool(options).run(
        { path: "talk.pptx", slides: SLIDES, overwrite: true },
        ctx(),
      );
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/^refused: talk\.pptx is an input the request names/);
      expect(result.summary).toContain('"Replace talk.pptx?"');
      expect(result.summary).not.toContain("overwrite");
      expect(result.details).toMatchObject({ refused: "input", input: "request", overwrite: true });
      expect(autoPrompts).toHaveLength(0);
      expect((await readFile(join(dir, "talk.pptx"))).equals(original)).toBe(true);

      // The same file through os.fs.write is refused with the same words.
      const write = await buildOsFsWriteTool(options).run(
        { path: "talk.pptx", content: "x", overwrite: true },
        ctx(),
      );
      expect(write.status).toBe("error");
      expect(write.details).toMatchObject({ refused: "input", input: "request" });
    });

    it("refuses a deck a fan-out declared as an input, without a store or a request", async () => {
      await writeFile(join(dir, "talk.pptx"), "the user's talk");
      const registry = new DeclaredInputsRegistry();
      registry.declare("s-pptx", [join(dir, "talk.pptx")]);
      const result = await buildOsFsWritePptxTool({
        approvals: auto,
        approvalRequired: true,
        declaredInputs: registry,
      }).run({ path: "talk.pptx", slides: SLIDES, overwrite: true }, ctx());
      expect(result.status).toBe("error");
      expect(result.details).toMatchObject({ refused: "input", input: "contract" });
      expect(await readFile(join(dir, "talk.pptx"), "utf8")).toBe("the user's talk");
    });

    it("keeps a restore copy of a replaced deck the request does not name, and os.fs.restore brings it back", async () => {
      const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe, 0x10]);
      await writeFile(join(dir, "old.pptx"), original);
      const options = {
        approvals: auto,
        approvalRequired: true,
        restore: store,
        resolveOriginalRequest: () => "Make me a launch deck",
      };
      const result = await buildOsFsWritePptxTool(options).run(
        { path: "old.pptx", slides: SLIDES, overwrite: true },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.details).toMatchObject({ replaced: true, restoreCopy: true });
      expect(result.summary).toContain("replaced the user's file `old.pptx`");
      expect(result.summary).toContain('os.fs.restore {"path":"old.pptx"}');

      const restored = await buildOsFsRestoreTool(options).run({ path: "old.pptx" }, ctx());
      expect(restored.status).toBe("ok");
      expect((await readFile(join(dir, "old.pptx"))).equals(original)).toBe(true);
    });

    it("replaces its own deck without a copy or a refusal", async () => {
      const options = {
        approvals: auto,
        approvalRequired: true,
        restore: store,
        resolveOriginalRequest: () => "Make talk.pptx from my notes",
      };
      const tool = buildOsFsWritePptxTool(options);
      expect((await tool.run({ path: "talk.pptx", slides: SLIDES }, ctx())).status).toBe("ok");
      const again = await tool.run({ path: "talk.pptx", slides: SLIDES, overwrite: true }, ctx());
      expect(again.status).toBe("ok");
      expect(again.details.restoreCopy).toBeUndefined();
      expect(await store.listCopies(dir)).toHaveLength(0);
    });
  });
});
