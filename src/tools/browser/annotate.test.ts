import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import type {
  AnnotateReadInput,
  AnnotateReadResult,
  AnnotateStartResult,
} from "./browser-backend.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import { browserShotDir } from "./screenshot.js";
import { ANNOTATE_SOURCE, buildBrowserAnnotateTool, type BrowserAnnotateDeps } from "./annotate.js";

/** `browser.annotate` (ATO-518) against a fake backend and an in-memory disk. */

function pin(id: number, path: string[], regionDepth: number) {
  return {
    id,
    comment: `make ${id} bigger`,
    selector: path.join(" > "),
    tag: "h2",
    text: "Pricing",
    rect: { x: 0, y: 100 * id, width: 300, height: 40 },
    styles: { "font-size": "20px", color: "rgb(17, 17, 17)" },
    path,
    regionDepth,
    attached: true,
  };
}

class AnnotateBackend extends GateBackend {
  public started = 0;
  public stopped = 0;
  public reads: AnnotateReadInput[] = [];
  public active = true;
  public picking = false;
  public pins: unknown[] = [pin(1, ["#pricing", "h2"], 0), pin(2, ["body", "footer", "p"], 1)];
  public frames: string[] = [];

  async startAnnotate(): Promise<AnnotateStartResult> {
    this.started += 1;
    return { url: this.url, started: this.started === 1, pins: 0 };
  }

  async readAnnotations(input: AnnotateReadInput): Promise<AnnotateReadResult> {
    this.reads.push(input);
    const crops = input.crops
      ? [
          { pinId: 1, buffer: Buffer.alloc(10, 1) },
          { pinId: 2, skipped: "too_large" },
        ]
      : [];
    return { url: this.url, frameUrls: [this.url, ...this.frames], active: this.active, picking: this.picking, pins: this.pins, crops };
  }

  async stopAnnotate(): Promise<{ url: string; removed: number }> {
    this.stopped += 1;
    return { url: this.url, removed: this.pins.length };
  }
}

function memoryDisk() {
  const files = new Map<string, Buffer>();
  const deps: BrowserAnnotateDeps = {
    tmpDir: () => "/tmp-test",
    ensureDir: async () => undefined,
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    now: () => new Date("2026-11-12T10:00:00.123Z"),
  };
  return { files, deps };
}

describe("browser.annotate", () => {
  it("start puts the overlay on and tells the agent to wait for the user", async () => {
    const backend = new AnnotateBackend();
    const { prompts, options } = recordingGate(false);
    const tool = buildBrowserAnnotateTool(backend, undefined, options, memoryDisk().deps);
    expect(tool.untrustedOutput).toBe(ANNOTATE_SOURCE);
    const result = await tool.run({ action: "start" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(backend.started).toBe(1);
    expect(result.summary).toContain('"action": "read"');
    expect(result.summary).toContain("do not click");
    expect(prompts).toHaveLength(0);
    const again = await tool.run({ action: "start" }, GATE_CTX);
    expect(again.summary).toContain("already on");
  });

  it("read returns pins grouped by page area, without crops by default", async () => {
    const backend = new AnnotateBackend();
    const { files, deps } = memoryDisk();
    const result = await buildBrowserAnnotateTool(backend, undefined, undefined, deps).run({ action: "read" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(backend.reads[0]).toMatchObject({ crops: false, maxCrops: 12 });
    expect(result.summary).toContain("2 pin(s)");
    expect(result.summary).toContain("Area 1: #pricing (pins 1)");
    expect(result.summary).toContain("Area 2: body > footer (pins 2)");
    expect(result.summary).toContain("[1] comment: make 1 bigger");
    expect(result.summary).toContain("selector: #pricing > h2");
    expect(result.summary).toContain("font-size: 20px");
    expect(result.details).toMatchObject({ groups: [{ region: "#pricing", pinIds: [1] }, { region: "body > footer", pinIds: [2] }] });
    expect(files.size).toBe(0);
  });

  it("read with crops saves each picture under the screenshot folder and names skipped ones", async () => {
    const backend = new AnnotateBackend();
    const { files, deps } = memoryDisk();
    const result = await buildBrowserAnnotateTool(backend, undefined, undefined, deps).run({ action: "read", crops: true }, GATE_CTX);
    const [path] = [...files.keys()];
    expect(path?.startsWith(browserShotDir("/tmp-test", GATE_CTX.sessionId))).toBe(true);
    expect(path?.endsWith("-pin1.jpg")).toBe(true);
    expect(result.summary).toContain(`crop: ${path}`);
    expect(result.summary).toContain("pin 2: too_large");
    expect(result.summary).toContain("vision.describe");
  });

  it("says when there is no overlay or no pin yet", async () => {
    const backend = new AnnotateBackend();
    const tool = buildBrowserAnnotateTool(backend, undefined, undefined, memoryDisk().deps);
    backend.active = false;
    const none = await tool.run({ action: "read" }, GATE_CTX);
    expect(none.details).toMatchObject({ reason: "not_active" });
    backend.active = true;
    backend.picking = true;
    backend.pins = [];
    const empty = await tool.run({ action: "read" }, GATE_CTX);
    expect(empty.summary).toContain("still waiting for the user");
  });

  it("refuses a blocked page and a page that frames one", async () => {
    const backend = new AnnotateBackend();
    const blocked = await buildBrowserAnnotateTool(
      backend,
      { blockedDomains: ["shop.example"], allowedDomains: [] },
      undefined,
      memoryDisk().deps,
    ).run({ action: "start" }, GATE_CTX);
    expect(blocked.details).toMatchObject({ reason: "blocked_domain" });
    expect(backend.started).toBe(0);

    backend.frames = ["https://bank.example/embed"];
    const framed = await buildBrowserAnnotateTool(
      backend,
      { blockedDomains: ["bank.example"], allowedDomains: [] },
      undefined,
      memoryDisk().deps,
    ).run({ action: "read" }, GATE_CTX);
    expect(framed.details).toMatchObject({ reason: "blocked_domain", host: "bank.example" });
    expect(framed.summary).not.toContain("make 1 bigger");
  });

  it("in the user's own Chrome a site not opened this session asks first", async () => {
    const backend = new AnnotateBackend();
    const { prompts, options } = recordingGate(true);
    const policy: BrowserDomainPolicy = {
      blockedDomains: [],
      allowedDomains: [],
      userProfile: true,
      userSites: new UserSiteApprovals(),
    };
    const tool = buildBrowserAnnotateTool(backend, policy, options, memoryDisk().deps);
    await tool.run({ action: "start" }, GATE_CTX);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "browser_secret", affectedResources: ["shop.example"] });
    await tool.run({ action: "read" }, GATE_CTX);
    expect(prompts).toHaveLength(1);
  });

  it("stop removes the overlay; bad actions and unsupported backends are errors", async () => {
    const backend = new AnnotateBackend();
    const tool = buildBrowserAnnotateTool(backend, undefined, undefined, memoryDisk().deps);
    const stopped = await tool.run({ action: "stop" }, GATE_CTX);
    expect(stopped.summary).toContain("2 pin(s) dropped");
    expect(backend.stopped).toBe(1);
    await expect(tool.run({ action: "pin" }, GATE_CTX)).rejects.toThrow("start|read|stop");
    const plain = await buildBrowserAnnotateTool(new GateBackend()).run({ action: "start" }, GATE_CTX);
    expect(plain.details).toMatchObject({ reason: "unsupported" });
  });
});
