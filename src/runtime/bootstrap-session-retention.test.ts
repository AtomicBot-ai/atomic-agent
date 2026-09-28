import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import { SessionStore } from "../session/index.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { LogRecord } from "../tracing/structured-logger.js";

import { createAgentRuntime } from "./bootstrap.js";

/**
 * The wiring end of session retention: the pass runs once at boot, only
 * when the operator turned it on, and says what it did in one line.
 *
 * The default matters most. Retention deletes the operator's own
 * transcripts, so an install that never opted in must come up with every
 * row it had — which is what the second case here checks against the
 * shipped defaults, not against a hand-written config.
 */

function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

describe("session retention through bootstrap", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-retention-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-retention-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  /** One session last touched a year ago, with a trace file beside it. */
  function seedAncientSession(id: string): string {
    const store = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    const at = Date.now() - 365 * 24 * 60 * 60 * 1000;
    store
      .getDatabaseHandleForRetention()
      .prepare(
        `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        workingDir,
        JSON.stringify({ id, turns: [], turnCount: 2 }),
        at,
        at,
      );
    store.close();
    const traces = join(stateDir, "traces");
    mkdirSync(traces, { recursive: true });
    const tracePath = join(traces, `${id}.ndjson`);
    writeFileSync(tracePath, `{"sessionId":"${id}"}\n`, "utf8");
    return tracePath;
  }

  function surviving(): string[] {
    const store = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    try {
      return store.listSummaries().map((row) => row.id);
    } finally {
      store.close();
    }
  }

  async function boot(logs: LogRecord[]): Promise<void> {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: { logSinks: [(record) => logs.push(record)] },
      overrides: {
        browserBackend: inertBackend(),
        skipLlamaHealthCheck: true,
      },
    });
    await runtime.shutdown();
  }

  it("prunes past the age cutoff and logs one line with the counts", async () => {
    const tracePath = seedAncientSession("ancient");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      sessions: { retention: { enabled: true, maxAgeDays: 90, maxRows: null } },
    });
    resetConfigCache();
    const logs: LogRecord[] = [];

    await boot(logs);

    expect(surviving()).not.toContain("ancient");
    expect(existsSync(tracePath)).toBe(false);
    const lines = logs.filter(
      (record) => record.message === "pruned sessions past retention",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.context).toMatchObject({
      deleted: 1,
      tracesRemoved: 1,
      maxAgeDays: 90,
    });
  });

  it("leaves everything alone, and says nothing, with the shipped defaults", async () => {
    const tracePath = seedAncientSession("ancient");
    const logs: LogRecord[] = [];

    await boot(logs);

    expect(surviving()).toContain("ancient");
    expect(existsSync(tracePath)).toBe(true);
    expect(
      logs.filter((record) => record.message.includes("retention")),
    ).toEqual([]);
  });
});
