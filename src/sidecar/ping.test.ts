import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapSidecar } from "./main.js";
import { resetConfigCache } from "../config/index.js";
import type { SidecarMessage } from "./sidecar-events.js";

/**
 * Issue #552 — `ping` answered with a hardcoded `version: "0.1.0"`, so a
 * host could not tell which agent build it was talking to. It reports the
 * same version `atomic-agent --version` prints.
 */
describe("sidecar ping", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let stdout: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-ping-"));
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    resetConfigCache();
  });

  it("reports the package version", async () => {
    // Listeners `bootstrapSidecar` adds to the process-wide streams are
    // removed on the way out (see `local-probe-gating.test.ts`).
    const before = new Map<string, unknown[]>([
      ["stdin:data", process.stdin.listeners("data").slice()],
      ["stdin:end", process.stdin.listeners("end").slice()],
      ["stdout:error", process.stdout.listeners("error").slice()],
      ["stdout:close", process.stdout.listeners("close").slice()],
    ]);
    const { shutdown } = await bootstrapSidecar();
    try {
      process.stdin.emit(
        "data",
        `${JSON.stringify({ kind: "request", id: "p1", type: "ping", payload: {} })}\n`,
      );
      const deadline = Date.now() + 5_000;
      let response: SidecarMessage | undefined;
      while (!response && Date.now() < deadline) {
        response = stdout
          .join("")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as SidecarMessage)
          .find((m) => m.kind === "response" && m.correlationId === "p1");
        if (!response) await new Promise((r) => setTimeout(r, 10));
      }
      const manifest = JSON.parse(
        readFileSync(join(process.cwd(), "package.json"), "utf8"),
      ) as { version: string };
      expect(response?.kind === "response" && response.ok).toBe(true);
      expect(
        response?.kind === "response"
          ? (response.payload as { version: string }).version
          : undefined,
      ).toBe(manifest.version);
    } finally {
      for (const [key, kept] of before) {
        const [target, event] = key.split(":") as ["stdin" | "stdout", string];
        const emitter = target === "stdin" ? process.stdin : process.stdout;
        for (const listener of emitter.listeners(event)) {
          if (!kept.includes(listener)) {
            emitter.removeListener(event, listener as () => void);
          }
        }
      }
      await shutdown();
    }
  });
});
