import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { appUpdater, readUpdatePrefs, updatePrefsPath } from "../updater.js";

/**
 * ATO-229 — app updates, in the smoke (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=65`.
 *
 * The product owner's rules, each driven through the real window: the
 * renderer's own toast and Settings rows, clicked where a person clicks, and
 * main's real updater (main/updater.ts) behind them. The feed is the updater's
 * fake (the same one `--fake-update=<version>` arms): a check finds the
 * version without the network, the download is a fake progress and Restart
 * records the install instead of quitting. A running turn is stood in through
 * the updater's test hook.
 *
 *  (a) a newer version is a toast at the top right, under the toolbar:
 *      "Atomic Agent X is available", a line of notes, Update / Not now and
 *      Skip this version; nothing downloads before a click;
 *  (b) Not now hides it, a later check this session keeps it away, a new
 *      start asks again;
 *  (c) Skip this version is written to updates.json and a new start does not
 *      ask about that version;
 *  (d) Update shows progress in the same toast, then Restart / Later;
 *  (e) Restart while a turn runs says "Restart when the answer finishes",
 *      waits, and installs once the turn is over;
 *  (f) Settings › General's switch off: an automatic check finds nothing to
 *      show (it does not even look);
 *  (g) Check now says "Version X is available", "You’re up to date — <v>".
 *
 * updates.json (Electron userData) is captured byte for byte first and put
 * back in `finally`; the updater and the window go back as they were.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

type ToastRead = {
  text: string; top: number; right: number; left: number; bottom: number;
  innerWidth: number; innerHeight: number; buttons: string[];
} | null;
type SettingsRead = { result: string; buttons: string[]; switchOn: boolean } | null;

const FAKE = "99.0.0";
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await wait(100);
    v = await read();
  }
  return v;
}

export async function checks65(js: Js, check: Check): Promise<void> {
  const u = appUpdater();
  check("T65: the updater is wired in main", !!u);
  if (!u) return;

  const path = updatePrefsPath();
  const before = existsSync(path) ? readFileSync(path) : null;
  const toast = () => js<ToastRead>("window.__updToast()");
  const settings = () => js<SettingsRead>("window.__updSettings()");
  const click = (sel: string) => js<boolean>(`(() => { const b = document.querySelector(${show(sel)}); if (!b) return false; b.click(); return true; })()`);
  const toastClick = (act: string) => click(`#toasts > .toast-upd:not(.out) [data-act="appupd:${act}"]`);
  const openGeneral = () => js<boolean>("(() => { S.settings = 1; S.settingsPane = 'general'; render(); return !!document.getElementById('set-upd-ver'); })()");
  const closeSettings = () => js<boolean>("(() => { S.settings = null; render(); return true; })()");
  /** A clean start: no updates.json, the fake feed armed, no choices made this session. */
  const fresh = async (fake: string | null) => {
    rmSync(path, { force: true });
    u.testReset(fake);
    await wait(50);
  };

  await js<boolean>("(() => { window.__t65keep = {settings: S.settings, pane: S.settingsPane, toasts: S.toasts}; S.settings = null; S.toasts = []; render(); return true; })()");
  try {
    /* (a) the toast, top right */
    await fresh(FAKE);
    await u.autoCheck();
    const t1 = await until(toast, (t) => !!t);
    check("T65 (a): a newer version raises the toast", !!t1 && t1.text.includes(`Atomic Agent ${FAKE} is available`), show(t1));
    check(
      "T65 (a): it sits at the top right of the window, under the toolbar",
      !!t1 && t1.innerWidth - t1.right <= 40 && t1.left > t1.innerWidth / 2 && t1.top >= 52 && t1.top <= 120,
      show(t1),
    );
    check(
      "T65 (a): Update, Not now and Skip this version, with a line of notes",
      !!t1 && ["Update", "Not now", "Skip this version"].every((b) => t1.buttons.includes(b)) && /fixes/i.test(t1.text),
      show(t1?.buttons),
    );
    const s1 = u.state();
    check("T65 (a): nothing is downloaded before a click", s1.phase === "available" && s1.percent === null, show(s1));

    /* (b) Not now */
    check("T65 (b): Not now is pressed", await toastClick("notnow"));
    const t2 = await until(toast, (t) => !t);
    check("T65 (b): Not now hides the toast", !t2 && u.state().toast === false, show(t2));
    await u.autoCheck();
    await wait(150);
    check("T65 (b): a later check this session does not ask again", !(await toast()) && u.state().toast === false, show(u.state()));
    check("T65 (b): the Not now is on record in updates.json", readUpdatePrefs().lastDismissed?.version === FAKE, show(readUpdatePrefs()));
    u.testNewSession();
    await u.autoCheck();
    const t3 = await until(toast, (t) => !!t);
    check("T65 (b): the next start asks again", !!t3 && t3.text.includes(FAKE), show(t3));

    /* (c) Skip this version */
    check("T65 (c): Skip this version is pressed", await toastClick("skip"));
    const t4 = await until(toast, (t) => !t);
    check("T65 (c): Skip hides the toast", !t4, show(t4));
    check("T65 (c): the skipped version is written to updates.json", readUpdatePrefs().skippedVersion === FAKE, show(readUpdatePrefs()));
    u.testNewSession();
    await u.autoCheck();
    await wait(150);
    check("T65 (c): a new start does not ask about the skipped version", !(await toast()) && u.state().toast === false, show(u.state()));

    /* (d) Update: progress, then Restart / Later */
    await fresh(FAKE);
    await u.autoCheck();
    await until(toast, (t) => !!t);
    check("T65 (d): Update is pressed", await toastClick("update"));
    const t5 = await until(toast, (t) => !!t && /\d+%/.test(t.text) && t.text.includes("Downloading"));
    const bar = await js<boolean>("!!document.querySelector('#toasts > .toast-upd .upd-prog > i')");
    check("T65 (d): the same toast shows the download's progress", !!t5 && bar && t5.buttons.includes("Cancel"), show(t5));
    const t6 = await until(toast, (t) => !!t && t.buttons.includes("Later"), 8_000);
    check(
      "T65 (d): when it is done the toast offers Restart and Later",
      !!t6 && t6.buttons.includes("Restart") && t6.buttons.includes("Later") && u.state().phase === "ready",
      show(t6),
    );
    check("T65 (d): nothing is installed before Restart", u.fakeInstalls === 0, `installs=${u.fakeInstalls}`);

    /* (e) Restart while a turn runs */
    u.testTurnBusy(true);
    const t7 = await until(toast, (t) => !!t && t.buttons.includes("Restart when the answer finishes"));
    check("T65 (e): with a turn running, Restart says it will wait", !!t7 && t7.buttons.includes("Restart when the answer finishes"), show(t7));
    check("T65 (e): Restart is pressed", await toastClick("install"));
    const t8 = await until(toast, (t) => !!t && t.text.includes("Restarting when the answer finishes"));
    check(
      "T65 (e): it waits for the answer and installs nothing yet",
      !!t8 && u.state().phase === "waiting" && u.fakeInstalls === 0,
      `${show(t8)} phase=${u.state().phase} installs=${u.fakeInstalls}`,
    );
    await wait(2_500);
    check("T65 (e): still waiting while the turn runs", u.state().phase === "waiting" && u.fakeInstalls === 0, `phase=${u.state().phase}`);
    u.testTurnBusy(false);
    const s2 = await until(async () => u.state(), (s) => s.phase === "installing", 5_000);
    check("T65 (e): once the turn is over it installs", s2.phase === "installing" && u.fakeInstalls === 1, `phase=${s2.phase} installs=${u.fakeInstalls}`);

    /* (f) the switch off: no automatic check, no toast */
    await fresh(FAKE);
    check("T65 (f): Settings › General draws the update rows", await openGeneral());
    const g1 = await settings();
    check("T65 (f): automatic checks are on by default", !!g1 && g1.switchOn && u.state().autoCheck, show(g1));
    check("T65 (f): the switch is pressed", await click('#set-upd-auto [data-act="appupd:auto"]'));
    const g2 = await until(settings, (g) => !!g && !g.switchOn);
    check("T65 (f): the switch goes off and updates.json says so", !!g2 && !g2.switchOn && readUpdatePrefs().autoCheck === false, `${show(g2)} ${show(readUpdatePrefs())}`);
    await closeSettings();
    await u.autoCheck();
    await wait(400);
    check("T65 (f): with it off an automatic check shows no toast", !(await toast()) && u.state().phase === "idle", show(u.state()));

    /* (g) Check now (the switch still off: Check now is the person asking) */
    await openGeneral();
    check("T65 (g): Check now is pressed", await click('#set-upd-ver [data-act="appupd:check"]'));
    const g3 = await until(settings, (g) => !!g && g.result.includes(`Version ${FAKE} is available`));
    check("T65 (g): Check now says the version that is available", !!g3 && g3.result.includes(`Version ${FAKE} is available`), show(g3));
    await fresh("0.0.0");
    await openGeneral();
    await click('#set-upd-ver [data-act="appupd:check"]');
    const current = u.state().currentVersion;
    const g4 = await until(settings, (g) => !!g && g.result.startsWith("You’re up to date"));
    check("T65 (g): Check now says when the app is up to date", !!g4 && g4.result === `You’re up to date — ${current}`, show(g4));
    await fresh(null);
    await openGeneral();
    const off = u.state();
    if (!off.enabled) {
      const g5 = await settings();
      check("T65 (g): a build with no feed says updates are not set up", !!g5 && /not set up for this build|package manager/.test(g5.result), show(g5));
    }
  } finally {
    u.testRestore();
    if (before) writeFileSync(path, before);
    else rmSync(path, { force: true });
    u.testRestore();
    await js<boolean>("(() => { const k = window.__t65keep; delete window.__t65keep; if (k) { S.settings = k.settings; S.settingsPane = k.pane; S.toasts = k.toasts; } render(); return true; })()");
  }
}
