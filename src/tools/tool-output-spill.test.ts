import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult } from "../compressor/result-compressor.js";
import { FUSION_WORKER_ID_PREFIX } from "../session/fusion-worker-session.js";
import { checkWorkerRead, findSessionReadOutside } from "./read-scope/index.js";
import { ToolRegistry, type ToolContext } from "./tool-registry.js";
import {
  FULL_OUTPUT_PATH_DETAIL,
  STALE_SPILL_MS,
  ToolOutputSpill,
  toolOutputDir,
} from "./tool-output-spill.js";

const longLog = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `log line ${i + 1}`).join("\n");

function shellResult(output: string) {
  return compressToolResult({ tool: "os.shell.run", status: "ok", output });
}

describe("ToolOutputSpill (ATO-663)", () => {
  let base: string;
  let spill: ToolOutputSpill;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-spill-"));
    spill = new ToolOutputSpill({ baseDir: base });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("saves a clipped result's full output and leads the summary with the path", async () => {
    const output = longLog(200);
    const result = shellResult(output);
    expect(result.truncated).toBe(true);
    const spilled = await spill.spill("os.shell.run", "s-1", result);
    const path = spilled.details[FULL_OUTPUT_PATH_DETAIL];
    expect(typeof path).toBe("string");
    expect(readFileSync(path as string, "utf8")).toBe(output);
    const firstLine = spilled.summary.split("\n")[0]!;
    expect(firstLine).toContain(path as string);
    expect(firstLine).toContain("200 lines");
    expect(firstLine).toContain("os.fs.read");
    // The clipped tail the model saw before is still there, after the note.
    expect(spilled.summary.endsWith(result.summary)).toBe(true);
    expect(path as string).toContain(join(base, "s-1"));
  });

  it("keeps the folder and the file owner-only", async () => {
    const spilled = await spill.spill("os.shell.run", "s-1", shellResult(longLog(50)));
    const path = spilled.details[FULL_OUTPUT_PATH_DETAIL] as string;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, "s-1")).mode & 0o777).toBe(0o700);
  });

  it("leaves a result that was not clipped alone", async () => {
    const result = shellResult("one\ntwo");
    expect(result.truncated).toBe(false);
    expect(await spill.spill("os.shell.run", "s-1", result)).toBe(result);
    expect(existsSync(join(base, "s-1"))).toBe(false);
  });

  it("never writes a tool that is not on the allowlist", async () => {
    for (const tool of ["os.clipboard.read", "os.http.request", "os.email.inbox", "os.fs.read"]) {
      const result = compressToolResult({ tool, status: "ok", output: longLog(100) });
      expect(await spill.spill(tool, "s-1", result)).toBe(result);
    }
    expect(existsSync(join(base, "s-1"))).toBe(false);
  });

  it("cuts a file at the per-file cap and says so", async () => {
    const small = new ToolOutputSpill({ baseDir: base, maxFileBytes: 100 });
    const spilled = await small.spill("os.shell.run", "s-1", shellResult(longLog(100)));
    const path = spilled.details[FULL_OUTPUT_PATH_DETAIL] as string;
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("[output cut at 100 bytes of");
    expect(spilled.summary.split("\n")[0]).toContain("the first part of it");
  });

  it("stops at the per-session budget", async () => {
    const tight = new ToolOutputSpill({ baseDir: base, maxSessionBytes: 3000 });
    const first = await tight.spill("os.shell.run", "s-1", shellResult(longLog(150)));
    expect(first.details[FULL_OUTPUT_PATH_DETAIL]).toBeDefined();
    const second = shellResult(longLog(150));
    expect(await tight.spill("os.shell.run", "s-1", second)).toBe(second);
    // Another session has its own budget.
    const other = await tight.spill("os.shell.run", "s-2", shellResult(longLog(150)));
    expect(other.details[FULL_OUTPUT_PATH_DETAIL]).toBeDefined();
  });

  it("refuses a session folder that is a symlink", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "atomic-spill-target-"));
    try {
      symlinkSync(elsewhere, join(base, "s-1"));
      const result = shellResult(longLog(100));
      expect(await spill.spill("os.shell.run", "s-1", result)).toBe(result);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("removes a session's folder", async () => {
    await spill.spill("os.shell.run", "s-1", shellResult(longLog(100)));
    expect(existsSync(join(base, "s-1"))).toBe(true);
    spill.removeSession("s-1");
    expect(existsSync(join(base, "s-1"))).toBe(false);
  });

  it("sweeps only folders untouched past the age limit", async () => {
    mkdirSync(join(base, "old"));
    writeFileSync(join(base, "old", "0001-x.txt"), "x");
    mkdirSync(join(base, "fresh"));
    const longAgo = (Date.now() - STALE_SPILL_MS - 60_000) / 1000;
    utimesSync(join(base, "old"), longAgo, longAgo);
    expect(spill.sweepStale()).toBe(1);
    expect(existsSync(join(base, "old"))).toBe(false);
    expect(existsSync(join(base, "fresh"))).toBe(true);
  });

  it("turns any session id into one path segment", () => {
    expect(toolOutputDir("../../etc", base)).toBe(join(base, "_etc"));
  });
});

describe("ToolRegistry output spill seam", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-spill-registry-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function registry(): ToolRegistry {
    const reg = new ToolRegistry({ outputSpill: new ToolOutputSpill({ baseDir: base }) });
    reg.register({
      name: "os.shell.run",
      description: "test shell",
      readonly: false,
      run: async () => shellResult(longLog(300)),
    });
    return reg;
  }

  const ctx = (modelMode?: "local" | "cloud"): ToolContext => ({
    workingDir: base,
    sessionId: "s-1",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...(modelMode ? { modelMode } : {}),
  });

  it("spills in local mode", async () => {
    const result = await registry().invoke("os.shell.run", {}, ctx("local"));
    expect(result.details[FULL_OUTPUT_PATH_DETAIL]).toBeDefined();
  });

  it("keeps promoting the full output in cloud mode, with no file", async () => {
    const result = await registry().invoke("os.shell.run", {}, ctx("cloud"));
    expect(result.details[FULL_OUTPUT_PATH_DETAIL]).toBeUndefined();
    expect(result.summary).toBe(longLog(300));
    expect(existsSync(join(base, "s-1"))).toBe(false);
  });

  it("leaves results alone without a spill", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "os.shell.run",
      description: "test shell",
      readonly: false,
      run: async () => shellResult(longLog(300)),
    });
    const result = await reg.invoke("os.shell.run", {}, ctx("local"));
    expect(result.details[FULL_OUTPUT_PATH_DETAIL]).toBeUndefined();
  });
});

describe("read scope for saved tool outputs", () => {
  const worker = `${FUSION_WORKER_ID_PREFIX}spill-test`;
  let work: string;
  let dir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "atomic-spill-work-"));
    dir = toolOutputDir(worker);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001-os.shell.run.txt"), "full log");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const workerCtx = () => ({ sessionId: worker, workingDir: work });

  it("lets a worker read its own saved output", () => {
    expect(
      checkWorkerRead("os.fs.read", { path: join(dir, "0001-os.shell.run.txt") }, workerCtx(), []),
    ).toBeNull();
  });

  it("does not open another session's folder to a worker", () => {
    const other = toolOutputDir(`${FUSION_WORKER_ID_PREFIX}someone-else`);
    expect(
      checkWorkerRead("os.fs.read", { path: join(other, "0001-x.txt") }, workerCtx(), []),
    ).not.toBeNull();
  });

  it("does not follow a symlink planted in the folder out of scope", () => {
    const outside = mkdtempSync(join(tmpdir(), "atomic-spill-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "no");
      symlinkSync(outside, join(dir, "link"));
      expect(
        checkWorkerRead("os.fs.read", { path: join(dir, "link", "secret.txt") }, workerCtx(), []),
      ).not.toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps a session read of its own output in scope", () => {
    const session = "s-spill-scope";
    const path = join(toolOutputDir(session), "0001-x.txt");
    expect(
      findSessionReadOutside("os.fs.read", { path }, { sessionId: session, workingDir: work }, [work]),
    ).toBeNull();
  });
});
