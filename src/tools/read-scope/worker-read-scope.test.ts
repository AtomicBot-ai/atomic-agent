import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { FUSION_WORKER_APPROVAL_MARKER } from "../fusion/worker-tool-policy.js";
import {
  checkWorkerRead,
  confineWorkerReads,
  WORKER_READ_REFUSAL_REASON,
  WORKER_READ_TOOL_TARGETS,
} from "./index.js";

const WORKER = `${FUSION_WORKER_ID_PREFIX}1`;

describe("worker read scope", () => {
  let root: string;
  let work: string;
  let sibling: string;

  beforeEach(() => {
    // The benchmark layout: two runs side by side, the worker in one.
    root = mkdtempSync(join(tmpdir(), "fusion-read-scope-"));
    work = join(root, "02-local", "work");
    sibling = join(root, "01-cloud-flash", "work", "js");
    mkdirSync(join(work, "js"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "main.js"), "someone else's code");
    writeFileSync(join(work, "js", "main.js"), "mine");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const worker = () => ({ sessionId: WORKER, workingDir: work });

  it("refuses a worker read that climbs out of its working directory", () => {
    const refusal = checkWorkerRead(
      "os.fs.read",
      { path: "../../01-cloud-flash/work/js/main.js" },
      worker(),
      [],
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe("error");
    expect(refusal!.summary).toContain(
      `outside this worker's working directory (${work})`,
    );
    expect(refusal!.summary).toContain(join(sibling, "main.js"));
    expect(refusal!.details.reason).toBe(WORKER_READ_REFUSAL_REASON);
    // A wandering read is the worker's own mistake, not a scope the
    // operator could widen: it must not turn the row `needs_orchestrator`.
    expect(refusal!.summary).not.toContain(FUSION_WORKER_APPROVAL_MARKER);
  });

  it("allows reads inside the tree, by relative or absolute path, and root-less searches", () => {
    for (const [tool, args] of [
      ["os.fs.read", { path: "js/main.js" }],
      ["os.fs.read", { path: join(work, "index.html") }],
      ["os.fs.list", { path: "." }],
      ["os.fs.grep", { pattern: "snake" }],
      ["os.fs.glob", { pattern: "**/*.js" }],
      ["os.fs.glob", { pattern: "*.js", cwd: "js" }],
    ] as const) {
      expect(checkWorkerRead(tool, { ...args }, worker(), []), tool).toBeNull();
    }
  });

  it("checks every path a multi-path or search tool names", () => {
    for (const [tool, args] of [
      ["os.fs.glob", { pattern: "**/*.js", cwd: "../.." }],
      ["os.fs.glob", { pattern: "**/*.js", path: sibling }],
      ["os.fs.grep", { pattern: "x", path: "/" }],
      ["os.fs.diff", { aPath: "js/main.js", bPath: join(sibling, "main.js") }],
      ["vision.describe", { paths: ["shot.png", join(root, "screen.png")] }],
      ["os.fs.list", { path: ".." }],
    ] as const) {
      expect(checkWorkerRead(tool, { ...args }, worker(), []), tool).not.toBeNull();
    }
  });

  it("leaves every non-worker session alone", () => {
    expect(
      checkWorkerRead(
        "os.fs.read",
        { path: join(sibling, "main.js") },
        { sessionId: "s-parent", workingDir: work },
        [],
      ),
    ).toBeNull();
  });

  it("lets a worker read back what its fan-out may write, even outside the working directory", () => {
    const shared = join(root, "shared");
    expect(
      checkWorkerRead(
        "os.fs.read",
        { path: join(shared, "out.js") },
        worker(),
        [shared],
      ),
    ).toBeNull();
    const refusal = checkWorkerRead(
      "os.fs.read",
      { path: join(sibling, "main.js") },
      worker(),
      [shared],
    );
    expect(refusal!.summary).toContain(
      `the directories this fan-out may write in (${shared})`,
    );
  });

  it("ignores URLs and tools that are not filesystem reads", () => {
    expect(
      checkWorkerRead(
        "vision.describe",
        { path: "https://example.com/a.png" },
        worker(),
        [],
      ),
    ).toBeNull();
    expect(
      checkWorkerRead("os.shell.run", { command: "cat /etc/hosts" }, worker(), []),
    ).toBeNull();
    expect(
      checkWorkerRead("os.fs.write", { path: "/etc/hosts" }, worker(), []),
    ).toBeNull();
  });

  it("accepts a path that is inside only by its canonical form", () => {
    // `/tmp` vs `/private/tmp`, or a symlinked checkout: really inside.
    const link = join(root, "link-to-work");
    symlinkSync(work, link);
    expect(
      checkWorkerRead(
        "os.fs.read",
        { path: join(work, "js", "main.js") },
        { sessionId: WORKER, workingDir: link },
        [],
      ),
    ).toBeNull();
  });

  it("confines the registered read tools once, at the registry every call goes through", async () => {
    const registry = new ToolRegistry();
    let innerCalls = 0;
    registry.register({
      name: "os.fs.read",
      description: "read",
      readonly: true,
      run: async () => {
        innerCalls += 1;
        return compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: "contents",
          details: {},
        });
      },
    });
    registry.register({
      name: "os.shell.run",
      description: "shell",
      readonly: false,
      run: async () =>
        compressToolResult({
          tool: "os.shell.run",
          status: "ok",
          output: "",
          details: {},
        }),
    });
    expect(confineWorkerReads(registry, { grantedDirs: () => [] })).toEqual([
      "os.fs.read",
    ]);
    const once = registry.get("os.fs.read");
    confineWorkerReads(registry, { grantedDirs: () => [] });
    expect(registry.get("os.fs.read")).toBe(once);
    expect(once.readonly).toBe(true);

    const ctx = (sessionId: string): ToolContext => ({
      sessionId,
      workingDir: work,
      stepIndex: 0,
      signal: new AbortController().signal,
    });
    const outside = { path: "../../01-cloud-flash/work/js/main.js" };
    const refused = await registry.invoke("os.fs.read", outside, ctx(WORKER));
    expect(refused.status).toBe("error");
    expect(innerCalls).toBe(0);

    expect(
      (await registry.invoke("os.fs.read", { path: "js/main.js" }, ctx(WORKER)))
        .status,
    ).toBe("ok");
    expect(innerCalls).toBe(1);

    expect(
      (await registry.invoke("os.fs.read", outside, ctx("s-parent"))).status,
    ).toBe("ok");
    expect(innerCalls).toBe(2);
  });

  it("names only real tools", () => {
    const known = new Set(DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name));
    for (const name of WORKER_READ_TOOL_TARGETS.keys()) {
      expect(known.has(name), `${name} is not a default tool descriptor`).toBe(
        true,
      );
    }
  });
});
