import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_CHANGED_ELSEWHERE,
  CONFIG_WRITE_TRIES,
  configBytesSha256,
  configWriteConflicted,
  managedDataDirNow,
  parseConfigWithSha,
  rewriteWholeConfig,
  withCliStandIn,
  type CliResult,
  type UserConfigShape,
} from "../agent-cli.js";
import { otherLiveModelSessions, quitMayStopModel, registerModelSession, SESSION_PARENT_PID_ENV } from "../model-sessions.js";
import {
  readStateDirsRecord,
  recordStateDirRun,
  SHARED_SETUP_NOTICE,
  sharedSetupNoticeDue,
} from "../shared-state-notice.js";
import { seedFreshStateDir } from "../state-dir-boot.js";
import {
  agentEnv,
  DESKTOP_STATE_DIR,
  desktopOwnsItsPorts,
  LEGACY_DESKTOP_STATE_DIR,
  resolveDesktopStateDir,
  SHARES_TERMINAL_STATE,
  STATE_DIR_FROM_ENV,
  TUI_STATE_DIR,
} from "../state-dir.js";

/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=116`.
 *
 * ATO-416 — the desktop shares the terminal agent's state directory, and the
 * two apps may run at once.
 *
 * (M1) The default directory is ~/.atomic-agent, the terminal's; an absolute
 *      ATOMIC_AGENT_STATE_DIR still wins, then ATOMIC_AGENT_DESKTOP_STATE_DIR;
 *      a relative one is ignored. Every cell of the resolution, as the pure
 *      function it is (this run itself is on an env-named directory, the one
 *      cell a launch can show). The private ports are claimed only off the
 *      terminal's directory, and the fresh-directory seed plants no weights
 *      link when the two directories are one.
 * (M2) Quit leaves a model up that another session holds: a live marker of
 *      another pid says "do not stop", the desktop's own pid is never
 *      "another", stale and junk markers are swept as the agent sweeps them.
 *      The desktop's own marker is down for this very launch, and every
 *      `atag` child is told its pid.
 * (M3) A whole-file config write is a compare-and-swap. With a stand-in agent
 *      whose file another writer keeps moving: the write is read, planned and
 *      written again and lands with BOTH changes; a file that moves under
 *      every try ends, after CONFIG_WRITE_TRIES, in the calm sentence and no
 *      write; an agent that gives no hash is written the old way, once.
 * (C16) The one-time "already set up in the terminal" notice: its rule as a
 *      truth table, its record, and the window's copy of the words.
 *
 * Throwaway directories under the OS temp dir only, removed in finally; the
 * stand-in answers every `atag` call of (M3), so no config is read or
 * written; the window's notice flag is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (x: unknown) => JSON.stringify(x);

export async function checks116(js: Js, check: Check): Promise<void> {
  m1();
  m2();
  await m3(check);
  await c16(js, check);

  /* ---- (M1) ---- */
  function m1(): void {
    const home = process.platform === "win32" ? "C:\\Users\\someone" : "/Users/someone";
    const lane = process.platform === "win32" ? "C:\\lanes\\a" : "/lanes/a";
    const own = process.platform === "win32" ? "C:\\desk\\b" : "/desk/b";
    const sep = process.platform === "win32" ? "\\" : "/";
    const cells = {
      none: resolveDesktopStateDir({}, home),
      state: resolveDesktopStateDir({ ATOMIC_AGENT_STATE_DIR: lane }, home),
      desktop: resolveDesktopStateDir({ ATOMIC_AGENT_DESKTOP_STATE_DIR: own }, home),
      both: resolveDesktopStateDir({ ATOMIC_AGENT_STATE_DIR: lane, ATOMIC_AGENT_DESKTOP_STATE_DIR: own }, home),
      relative: resolveDesktopStateDir({ ATOMIC_AGENT_STATE_DIR: "lanes/a", ATOMIC_AGENT_DESKTOP_STATE_DIR: "desk" }, home),
      blank: resolveDesktopStateDir({ ATOMIC_AGENT_STATE_DIR: "  " }, home),
      trailing: resolveDesktopStateDir({ ATOMIC_AGENT_STATE_DIR: lane + sep }, home),
    };
    check(
      "T116: the default state dir is the terminal agent's ~/.atomic-agent, and the env overrides still win",
      cells.none === join(home, ".atomic-agent") && cells.state === lane && cells.desktop === own && cells.both === lane
        && cells.relative === join(home, ".atomic-agent") && cells.blank === join(home, ".atomic-agent") && cells.trailing === lane,
      show(cells),
    );
    check(
      "T116: this launch resolved by the same rule (an env-named run is never the operator's directory)",
      TUI_STATE_DIR === join(homedir(), ".atomic-agent")
        && LEGACY_DESKTOP_STATE_DIR === join(homedir(), ".atomic-agent-desktop")
        && SHARES_TERMINAL_STATE === (DESKTOP_STATE_DIR === TUI_STATE_DIR)
        && (STATE_DIR_FROM_ENV ? !SHARES_TERMINAL_STATE : SHARES_TERMINAL_STATE),
      `state=${DESKTOP_STATE_DIR} tui=${TUI_STATE_DIR} legacy=${LEGACY_DESKTOP_STATE_DIR} fromEnv=${STATE_DIR_FROM_ENV} shared=${SHARES_TERMINAL_STATE}`,
    );
    check(
      "T116: the private 19191/19192 ports are claimed only off the terminal's directory",
      desktopOwnsItsPorts(TUI_STATE_DIR, TUI_STATE_DIR) === false && desktopOwnsItsPorts(join(tmpdir(), "x"), TUI_STATE_DIR) === true,
      `shared → ${desktopOwnsItsPorts(TUI_STATE_DIR, TUI_STATE_DIR)}; elsewhere → ${desktopOwnsItsPorts(join(tmpdir(), "x"), TUI_STATE_DIR)}`,
    );
    const root = mkdtempSync(join(tmpdir(), "aa-t116-seed-"));
    try {
      // One directory standing for both: real weights in it, as a terminal user's has.
      mkdirSync(join(root, "models", "models", "some-model"), { recursive: true });
      writeFileSync(join(root, "models", "models", "some-model", "weights.gguf"), "not really a model");
      seedFreshStateDir(root, root);
      const weights = lstatSync(join(root, "models", "models"));
      check(
        "T116: the fresh-directory seed plants no weights link when the desktop and terminal directories are one",
        weights.isDirectory() && !weights.isSymbolicLink() && existsSync(join(root, "models", "models", "some-model", "weights.gguf"))
          && !existsSync(join(root, "models", "backend")),
        `models/models symlink=${weights.isSymbolicLink()} dir=${weights.isDirectory()}; backend copied=${existsSync(join(root, "models", "backend"))}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /* ---- (M2) ---- */
  function m2(): void {
    const dir = mkdtempSync(join(tmpdir(), "aa-t116-sessions-"));
    try {
      const self = process.pid;
      const release = registerModelSession(dir, self);
      const marker = join(dir, "sessions", String(self));
      // ATO-418: the first line is the pid; macOS and Linux add the process start on a second.
      const written = existsSync(marker) && readFileSync(marker, "utf8").split("\n")[0] === String(self);
      const aloneReal = quitMayStopModel(dir, self);
      // Another session, alive by the stand-in liveness test; a dead one; a file that is not a pid.
      const other = 424242;
      const dead = 434343;
      writeFileSync(join(dir, "sessions", String(other)), String(other));
      writeFileSync(join(dir, "sessions", String(dead)), String(dead));
      writeFileSync(join(dir, "sessions", "not-a-pid"), "x");
      const alive = (pid: number) => pid === other;
      const withOther = quitMayStopModel(dir, self, alive);
      const left = readdirSync(join(dir, "sessions")).sort();
      // The other session ends: its marker is now stale, and the quit may stop the server.
      const afterOther = quitMayStopModel(dir, self, () => false);
      release();
      release();   // twice is safe
      const gone = !existsSync(marker);
      check(
        "T116: quit stops the shared model only when no OTHER live session marker is there",
        written && aloneReal.stop === true && aloneReal.others.length === 0
          && withOther.stop === false && show(withOther.others) === show([other])
          && show(left) === show([String(other), String(self)].sort())
          && afterOther.stop === true && otherLiveModelSessions(dir, self, alive).length === 0
          && gone,
        `own marker written=${written}; alone → ${show(aloneReal)}; with ${other} live → ${show(withOther)}; left after the sweep ${show(left)}; `
          + `after it ended → ${show(afterOther)}; own marker released=${gone}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const boot = join(managedDataDirNow(), "sessions", String(process.pid));
    const env = agentEnv();
    check(
      "T116: this launch holds its own session marker, and every atag child is told the desktop's pid",
      existsSync(boot) && env[SESSION_PARENT_PID_ENV] === String(process.pid),
      `${boot} exists=${existsSync(boot)}; ${SESSION_PARENT_PID_ENV}=${env[SESSION_PARENT_PID_ENV]} (main pid ${process.pid})`,
    );
  }

  /* ---- (M3) ---- */
  async function m3(chk: Check): Promise<void> {
    type World = { file: Record<string, unknown>; moves: number; withSha: boolean };
    const run = async (world: World) => {
      const calls: string[][] = [];
      const hashOf = () => configBytesSha256(JSON.stringify(world.file));
      const said = (stdout: string): CliResult => ({ ok: true, stdout, stderr: "" });
      const standIn = async (args: string[], input?: string): Promise<CliResult> => {
        calls.push(args);
        const verb = args.slice(0, 2).join(" ");
        if (verb === "config get") {
          return said(world.withSha && args.includes("--with-sha256")
            ? JSON.stringify({ sha256: hashOf(), config: world.file })
            : JSON.stringify(world.file));
        }
        if (verb === "config set" && args[2] === "-" && input !== undefined) {
          const at = args.indexOf("--expect-sha256");
          const expect = at >= 0 ? args[at + 1] : null;
          // Another writer lands between this hold's read and its write.
          if (world.moves > 0) {
            world.moves--;
            world.file = { ...world.file, terminalWrites: Number(world.file["terminalWrites"] ?? 0) + 1 };
          }
          if (expect !== null && expect !== hashOf()) {
            return { ok: false, stdout: "", stderr: "config changed since it was read\n", error: "config changed since it was read", exitCode: 3 };
          }
          world.file = JSON.parse(input) as Record<string, unknown>;
          return said("");
        }
        return { ok: false, stdout: "", stderr: "", error: "smoke stand-in: not answered: " + verb };
      };
      let plans = 0;
      const res = await withCliStandIn(standIn, () => rewriteWholeConfig((cfg: UserConfigShape) => {
        plans++;
        (cfg as unknown as Record<string, unknown>)["desktopWrote"] = true;
        return { write: true };
      }));
      const sets = calls.filter((a) => a[0] === "config" && a[1] === "set");
      const gets = calls.filter((a) => a[0] === "config" && a[1] === "get");
      return { res, plans, sets, gets, file: world.file };
    };

    const twice = await run({ file: { version: 1 }, moves: 2, withSha: true });
    chk(
      "T116: a write refused because the file moved is re-read, re-planned and lands with both changes",
      twice.res.ok && twice.res.changed && twice.plans === 3 && twice.gets.length === 3 && twice.sets.length === 3
        && twice.sets.every((a) => a.includes("--expect-sha256"))
        && twice.file["desktopWrote"] === true && twice.file["terminalWrites"] === 2,
      `ok=${twice.res.ok} plans=${twice.plans} reads=${twice.gets.length} writes=${twice.sets.length} file=${show(twice.file)}`,
    );

    const always = await run({ file: { version: 1 }, moves: 99, withSha: true });
    chk(
      "T116: a file that moves under every try ends in a calm sentence, and nothing of the desktop's is written",
      !always.res.ok && always.res.error === CONFIG_CHANGED_ELSEWHERE && always.plans === CONFIG_WRITE_TRIES
        && always.sets.length === CONFIG_WRITE_TRIES && always.file["desktopWrote"] === undefined
        && !/[\u2013\u2014]/.test(CONFIG_CHANGED_ELSEWHERE),
      `ok=${always.res.ok} error=${show(always.res.error)} plans=${always.plans} writes=${always.sets.length} file=${show(always.file)}`,
    );

    const old = await run({ file: { version: 1 }, moves: 0, withSha: false });
    chk(
      "T116: an agent that gives no hash is written the old way, once",
      old.res.ok && old.plans === 1 && old.sets.length === 1 && !old.sets[0]!.includes("--expect-sha256") && old.file["desktopWrote"] === true,
      `ok=${old.res.ok} plans=${old.plans} write args=${show(old.sets[0])}`,
    );

    const sha = "a".repeat(64);
    const wrapped = parseConfigWithSha(JSON.stringify({ sha256: sha, config: { x: 1 } }));
    const plain = parseConfigWithSha(JSON.stringify({ x: 1 }));
    chk(
      "T116: both answers of the hashed read are understood, and exit 3 is the conflict",
      wrapped?.sha256 === sha && show(wrapped?.config) === show({ x: 1 }) && plain?.sha256 === null && show(plain?.config) === show({ x: 1 })
        && parseConfigWithSha("not json") === null
        && configWriteConflicted({ ok: false, stdout: "", stderr: "", exitCode: 3 })
        && !configWriteConflicted({ ok: false, stdout: "", stderr: "boom", exitCode: 1 })
        && configBytesSha256(null) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      `wrapped=${show(wrapped)} plain=${show(plain)} empty=${configBytesSha256(null)}`,
    );
  }

  /* ---- (C16) ---- */
  async function c16(win: Js, chk: Check): Promise<void> {
    const done = { tui: { onboarding: { completedAt: "2026-10-01T10:00:00.000Z" } } };
    const cell = (shared: boolean, fresh: boolean, config: unknown, ranHereBefore: boolean) => sharedSetupNoticeDue({ shared, fresh, config, ranHereBefore });
    const table = {
      due: cell(true, false, done, false),
      ranBefore: cell(true, false, done, true),
      fresh: cell(true, true, done, false),
      notShared: cell(false, false, done, false),
      skipped: cell(true, false, { tui: { onboarding: { skippedAt: "2026-10-01T10:00:00.000Z" } } }, false),
      noStamps: cell(true, false, { tui: { onboarding: {} } }, false),
      noConfig: cell(true, false, null, false),
      hadDesktop: sharedSetupNoticeDue({ shared: true, fresh: false, config: done, ranHereBefore: false, hadDesktopSetup: true }),
    };
    const dir = mkdtempSync(join(tmpdir(), "aa-t116-record-"));
    let recorded: string[] = [];
    try {
      const file = join(dir, "state-dirs.json");
      const before = readStateDirsRecord(file);
      recordStateDirRun(file, "/a");
      recordStateDirRun(file, "/a");
      recordStateDirRun(file, "/b");
      recorded = readStateDirsRecord(file);
      chk(
        "T116: the notice is owed only to a shared, existing, finished setup this desktop never ran on, and is then recorded",
        table.due && !table.ranBefore && !table.fresh && !table.notShared && !table.skipped && !table.noStamps && !table.noConfig && !table.hadDesktop
          && before.length === 0 && show(recorded) === show(["/a", "/b"]),
        `${show(table)}; record ${show(recorded)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const words = await win<string>("SHARED_SETUP_NOTICE");
    const on = await win<{ was: boolean; show: boolean; text: string | null; firstInEmptyChat: boolean }>("window.__sharedSetupNotice(true)");
    const off = await win<{ was: boolean; show: boolean; text: string | null; firstInEmptyChat: boolean }>("window.__sharedSetupNotice(" + String(on.was) + ")");
    chk(
      "T116: the window says it in main's words, first in the empty chat, with no dashes",
      words === SHARED_SETUP_NOTICE && on.show && on.text === SHARED_SETUP_NOTICE && on.firstInEmptyChat
        && off.show === on.was && !/[\u2013\u2014]/.test(SHARED_SETUP_NOTICE),
      `renderer=${show(words)}; shown=${show(on)}; put back=${show(off)}`,
    );
  }
}
