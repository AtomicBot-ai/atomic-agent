/**
 * Release-fix checks for backlog item 03 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=03`.
 *
 * 03 — on a fresh install the chat window was on screen for a moment before
 * the wizard, and the wizard's title card then waited for a click under
 * "Click anywhere, or press any key". The prepared state this lane runs on is
 * never fresh, so the first half is proved the one way it can be: a second
 * launch against an empty directory (`--first-run-probe`), read frame by
 * frame. The card's timers are driven here, on the shipped functions, and
 * every flow opened is closed again with nothing written to config.
 */

import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { app } from "electron";

import type { BootPaintSummary } from "../boot-paint.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* In the page: open the card through the test jump (no timers of its own)
   with its stamp already spent, so leaving it writes nothing to config, then
   time how long it stays. `arm` is what the timers under test are given. */
const timeCard = (arm: string, probeAt: number, giveUp: number) => `(async () => {
  window.__obOpen('intro');
  OB_STAMPED.introSeenAt = true;
  const gen = OB.openGen, t0 = Date.now();
  ${arm}
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  let early = null, leftAt = null;
  while (Date.now() - t0 < ${giveUp}) {
    if (early === null && Date.now() - t0 >= ${probeAt}) early = OB.step;
    if (OB.step !== 'intro') { leftAt = Date.now() - t0; break; }
    await tick(20);
  }
  return {early, leftAt, step: OB.step, writes: OB_STAMP_LOG.length};
})()`;

export async function checks03(js: Js, check: Check): Promise<void> {
  // A build without the fix has none of these functions: that is a FAIL with its reason, not a dead suite.
  const run = async (code: string): Promise<Record<string, unknown>> => {
    try {
      return (await js<Record<string, unknown> | null>(code)) ?? {};
    } catch (e) {
      return { err: e instanceof Error ? e.message : String(e) };
    }
  };

  try {
    // The card asks for nothing any more.
    const card = await run(`(() => {
      const box = document.createElement('div'); box.innerHTML = obIntroHTML();
      return {line: !!box.querySelector('.ob-any'), children: box.querySelectorAll('.ob-introc > *').length,
        asks: /press any key|click anywhere/i.test(box.textContent || ''), copy: typeof OB_COPY.pressAnyKey};
    })()`);
    check(
      "T03: the title card carries no \"Click anywhere, or press any key\" line",
      card.line === false && card.children === 3 && card.asks === false && card.copy === "undefined",
      JSON.stringify(card),
    );

    // The latch the first paint is decided on is the one main holds.
    const latch = await run("({boot: window.atomic.freshAtBoot, ipc: window.__firstRun()})");
    const ipc = latch.ipc as { fresh?: unknown } | null | undefined;
    check(
      "T03: the fresh flag the window is born with agrees with app:firstRun",
      typeof latch.boot === "boolean" && !!ipc && latch.boot === ipc.fresh,
      JSON.stringify(latch),
    );

    // The reads land at once: the card still has its minimum on screen.
    const soon = await run(timeCard("obIntroArm(gen); obIntroLoaded(gen);", 500, 2500));
    check(
      "T03: once setup is read the card leaves by itself, but not before 0.7 s",
      soon.early === "intro" && typeof soon.leftAt === "number" && soon.leftAt >= 680 && soon.leftAt <= 1500
        && soon.step === "choose" && soon.writes === 0,
      JSON.stringify(soon),
    );
    await run("window.__obClose()");

    // Opened the way first run and the menu open it: nobody touches it, it leaves.
    const real = await run(`(async () => {
      window.__obMenuOpen();
      OB_STAMPED.introSeenAt = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 7000 && OB.open && OB.step === 'intro') await new Promise((r) => setTimeout(r, 20));
      return {ms: Date.now() - t0, step: OB.step, open: OB.open};
    })()`);
    check(
      "T03: opened by the production path, the card leaves by itself once its reads are in (0.7–5 s)",
      real.step === "choose" && typeof real.ms === "number" && real.ms >= 680 && real.ms <= 5600,
      JSON.stringify(real),
    );
    await run("window.__obClose()");

    // An input still skips it at once — a real keydown through the wizard's own listener, and a click.
    const skip = await run(`(() => {
      const out = {};
      window.__obMenuOpen(); OB_STAMPED.introSeenAt = true;
      document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'x', bubbles: true, cancelable: true}));
      out.key = OB.step;
      window.__obClose();
      window.__obMenuOpen(); OB_STAMPED.introSeenAt = true;
      document.getElementById('onboarding').click();
      out.click = OB.step;
      window.__obClose();
      return out;
    })()`);
    check("T03: a key or a click still skips the card at once", skip.key === "choose" && skip.click === "choose", JSON.stringify(skip));

    /* The reads hang: the ceiling moves it at 5 s. The flows opened above
       left their own timers running (the two skipped ones are a second old
       by now, so their ceilings would land a second early); a card that
       moved before 4.5 s would be one of them acting on a flow that is not
       theirs. */
    await wait(1000);
    const stuck = await run(timeCard("obIntroArm(gen);", 4500, 7000));
    check(
      "T03: with the reads stuck the card leaves at the 5 s ceiling, and an earlier card's timers never move it",
      stuck.early === "intro" && typeof stuck.leftAt === "number" && stuck.leftAt >= 4900 && stuck.leftAt <= 6000
        && stuck.step === "choose" && stuck.writes === 0,
      JSON.stringify(stuck),
    );
  } finally {
    await run("window.__obClose()");
  }

  /* A genuinely fresh launch, frame by frame — the same child the item-9
     check in main.ts starts: an empty ATOMIC_AGENT_STATE_DIR, no
     `--onboarding`, no `atag serve`, its own Chromium profile. */
  const root = join(app.getPath("temp"), `atomic-desktop-t03-${process.pid}`);
  type Probe = BootPaintSummary & { fresh: boolean | null; open: boolean };
  let probe: Probe | null = null;
  let why = "";
  try {
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [app.getAppPath(), "--first-run-probe", `--user-data-dir=${join(root, "chromium")}`],
      { env: { ...process.env, ATOMIC_AGENT_STATE_DIR: state }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("FIRSTRUNPROBE "));
    if (line) probe = JSON.parse(line.slice("FIRSTRUNPROBE ".length)) as Probe;
    else why = `no FIRSTRUNPROBE line in ${JSON.stringify(stdout.slice(-300))}`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const seen = probe ? `${probe.timeline} (frames ${probe.frames})` : why;
  check(
    "T03: a fresh launch paints the wizard first — the chat window is never on screen before it",
    !!probe && probe.fresh === true && probe.open === true && probe.frames > 0
      && probe.chatBeforeWizard === false && probe.chatFrames === 0 && probe.chatShownMs === 0,
    probe ? `chat frames before the wizard ${probe.chatFrames}, on screen ${probe.chatShownMs} ms; ${seen}` : seen,
  );
  check(
    "T03: on a fresh launch the title card leaves by itself, untouched, once setup is read",
    !!probe && probe.introLeftBySelf === true && typeof probe.introMs === "number"
      && probe.introMs >= 500 && probe.introMs <= 6000,
    probe ? `left by itself=${probe.introLeftBySelf} after ${probe.introMs} ms, input=${probe.input}; ${seen}` : seen,
  );
}
