/**
 * The real `atag tui` in a real pseudo-terminal (ATO-658).
 *
 * Everything else in src/tui renders React into a string. These tests
 * launch the CLI under node-pty and read the screen and the terminal
 * modes from @xterm/headless, so they see what a user's terminal sees:
 * the alternate screen, mouse reporting, a repaint after resize, and the
 * state the shell is left in after the process ends.
 *
 * They need `node-pty` and `@xterm/headless`, which are not in
 * package.json (see pty-session.fixture.ts). Without them the suite is
 * skipped; the `TUI (real terminal)` workflow installs them and runs
 * `npx vitest run src/tui/pty`. Uses `dist/cli/index.js` when built,
 * otherwise `tsx src/cli/index.ts` (slower cold start).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadPtyDeps, PtySession } from "./pty-session.fixture.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli", "index.js");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const SRC_CLI = join(REPO_ROOT, "src", "cli", "index.ts");

/** Cold start on a CI runner, through tsx, can take most of a minute. */
const BOOT_MS = 90_000;
const TEST_MS = 180_000;

const deps = await loadPtyDeps();
// The workflow that installs the packages sets this, so a native module
// that fails to load there is a red run, not a silent skip.
if (deps === null && process.env.ATOMIC_AGENT_PTY_TESTS === "1") {
  throw new Error("ATOMIC_AGENT_PTY_TESTS=1 but node-pty or @xterm/headless did not load");
}

function cliCommand(): { command: string; args: string[] } {
  if (existsSync(DIST_CLI)) return { command: process.execPath, args: [DIST_CLI, "tui"] };
  return { command: TSX_BIN, args: [SRC_CLI, "tui"] };
}

/**
 * The child's environment. Ink renders nothing while it thinks it is in
 * CI (it waits to print the last frame on exit), and GitHub Actions sets
 * `CI=true`; `CI=false` is the value its check treats as "not CI". No
 * `NO_COLOR` either, for the same reason.
 */
function childEnv(stateDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "NO_COLOR" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    CI: "false",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ATOMIC_AGENT_STATE_DIR: stateDir,
    ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP: "1",
    DO_NOT_TRACK: "1",
  };
}

const sessions: PtySession[] = [];
const stateDirs: string[] = [];

function boot(cols = 120, rows = 40): PtySession {
  if (!deps) throw new Error("pty deps missing");
  const stateDir = mkdtempSync(join(tmpdir(), "aa-pty-"));
  stateDirs.push(stateDir);
  const { command, args } = cliCommand();
  const session = new PtySession(deps, { command, args, cwd: REPO_ROOT, env: childEnv(stateDir), cols, rows });
  sessions.push(session);
  return session;
}

/** Waits for the first real frame: alternate screen on and a few rows drawn. */
async function firstFrame(session: PtySession): Promise<string> {
  const deadline = Date.now() + BOOT_MS;
  const text = await session.waitFor(
    (screen) => screen.split("\n").filter((row) => row.trim().length > 0).length >= 3,
    { timeoutMs: BOOT_MS, label: "the first frame" },
  );
  while ((await session.terminalState()).buffer !== "alternate" && Date.now() < deadline) {
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return text;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(deps === null)("atag tui in a real terminal", () => {
  it("boots into the alternate screen with mouse reporting on", async () => {
    const session = boot();
    const text = await firstFrame(session);
    const state = await session.terminalState();
    expect(state.buffer).toBe("alternate");
    // `tui.mouse` defaults to true; the restore checks below rely on it.
    expect(state.mouseTracking).not.toBe("none");
    expect(text.trim().length).toBeGreaterThan(0);
  }, TEST_MS);

  it("swaps in the too-small card below the floor and comes back after", async () => {
    const session = boot();
    await firstFrame(session);
    session.resize(30, 10);
    const small = await session.waitFor((screen) => /needs \d+x\d+/.test(screen), {
      timeoutMs: 15_000,
      label: "the too-small card",
    });
    expect(small).toMatch(/this one is 30x10/);
    session.resize(120, 40);
    await session.waitFor(
      (screen) => !/needs \d+x\d+/.test(screen) && screen.split("\n").filter((row) => row.trim()).length >= 3,
      { timeoutMs: 15_000, label: "the full UI after growing back" },
    );
  }, TEST_MS);

  it("hands the terminal back after one SIGTERM", async () => {
    const session = boot();
    await firstFrame(session);
    session.signal("SIGTERM");
    const exit = await session.waitForExit(30_000);
    expect(exit, "the TUI did not exit within 30 s of SIGTERM").not.toBeNull();
    const state = await session.terminalState();
    expect(state.buffer).toBe("normal");
    expect(state.mouseTracking).toBe("none");
  }, TEST_MS);

  it("still hands the terminal back when a second signal escalates", async () => {
    const session = boot();
    await firstFrame(session);
    session.signal("SIGTERM");
    session.signal("SIGTERM");
    const exit = await session.waitForExit(30_000);
    expect(exit, "the TUI did not exit within 30 s of two SIGTERMs").not.toBeNull();
    const state = await session.terminalState();
    expect(state.buffer).toBe("normal");
    expect(state.mouseTracking).toBe("none");
  }, TEST_MS);
});
