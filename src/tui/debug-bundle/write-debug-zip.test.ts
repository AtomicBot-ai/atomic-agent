import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

import { writeDebugBundleZip } from "./write-debug-zip.js";
import type { DebugBundleSnapshot } from "./build-snapshot.js";

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "debug-bundle-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function stubSnapshot(sessionId: string | null): DebugBundleSnapshot {
  return {
    session: {
      sessionId,
      workingDir: "/tmp/work",
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chromium",
      browserHeadless: true,
      approvalRequired: false,
      maxSteps: 12,
      skillCount: 0,
    },
    uiMode: "chat",
    activeTab: "feed",
    lastRunStatus: null,
    messages: [],
    feed: [],
    logs: [],
    reasoning: [],
    runHistory: [],
    metrics: {
      promptTokensLast: null,
      completionTokensLast: null,
      llmDurationMsLast: null,
      stepDurationMsLast: null,
      kvCacheHits: 0,
      kvCacheMisses: 0,
      totalTokens: 0,
      toolsOk: 0,
      toolsError: 0,
    },
  };
}

describe("writeDebugBundleZip", () => {
  it("writes snapshot + manifest + present trace files into a zip", async () => {
    await withTmp(async (root) => {
      const traceDir = join(root, "traces");
      await mkdir(traceDir, { recursive: true });
      await writeFile(
        join(traceDir, "s-1.ndjson"),
        '{"type":"session_started","seq":1,"sessionId":"s-1"}\n',
        "utf8",
      );
      const outDir = join(root, "out");
      const now = new Date("2026-04-24T12:34:56.789Z");
      const result = await writeDebugBundleZip({
        snapshot: stubSnapshot("s-1"),
        traceDir,
        traceEnabled: true,
        sessionIds: ["s-1", "s-missing"],
        outDir,
        now,
      });
      expect(result.includedTraces).toBe(1);
      expect(result.skippedTraces).toBe(1);
      expect(result.path).toBe(
        join(outDir, "atomic-agent-debug-2026-04-24T12-34-56.789Z.zip"),
      );
      const zip = await JSZip.loadAsync(
        await import("node:fs/promises").then((fs) => fs.readFile(result.path)),
      );
      const fileNames = Object.values(zip.files)
        .filter((f) => !f.dir)
        .map((f) => f.name)
        .sort();
      expect(fileNames).toEqual([
        "manifest.json",
        "traces/s-1.ndjson",
        "tui-snapshot.json",
      ]);
      const manifest = JSON.parse(
        await zip.file("manifest.json")!.async("string"),
      );
      expect(manifest.currentSessionId).toBe("s-1");
      expect(manifest.traceDir).toBe(traceDir);
      expect(manifest.traceEnabled).toBe(true);
      expect(manifest.traces).toEqual([
        expect.objectContaining({ sessionId: "s-1", included: true }),
        expect.objectContaining({ sessionId: "s-missing", included: false }),
      ]);
    });
  });

  it("still writes an archive when no trace files are available", async () => {
    await withTmp(async (root) => {
      const traceDir = join(root, "traces");
      const outDir = join(root, "out");
      const result = await writeDebugBundleZip({
        snapshot: stubSnapshot(null),
        traceDir,
        traceEnabled: false,
        sessionIds: [],
        outDir,
      });
      expect(result.includedTraces).toBe(0);
      expect(result.skippedTraces).toBe(0);
      const zip = await JSZip.loadAsync(
        await import("node:fs/promises").then((fs) => fs.readFile(result.path)),
      );
      expect(zip.file("manifest.json")).not.toBeNull();
      expect(zip.file("tui-snapshot.json")).not.toBeNull();
    });
  });
});
