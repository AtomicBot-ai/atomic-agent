/**
 * L13: doctor, backup and restore, from the terminal and from Settings.
 *
 * The person: someone whose install has a problem or who is about to do
 * something risky, so they run the checks and keep a backup.
 * The human result: doctor names the real problem and Fix really repairs it; a
 * backup taken now really brings back this moment; a restore only happens
 * after they confirm it, and the folder it replaced is kept.
 *
 * It fails if doctor misses a config.json other users can read, if Fix does
 * not change the file's mode, if the archive is missing or world-readable, if
 * a restore runs without confirmation, if a file from before the backup does
 * not come back, if a file from after it survives, if the replaced folder is
 * deleted, if the chat history does not survive, or if the window does not
 * come back after a restore.
 *
 * The Back up and Restore buttons open system dialogs that the window's own
 * debugging connection cannot reach. They are answered here by macOS System
 * Events, which clicks them as a person does. That needs the Accessibility
 * permission; without it the run reports SKIP and says why, after the terminal
 * and Doctor parts have passed.
 */

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_DIR, launch } from '../drive.mjs';
import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { reply } from './scripted-model.mjs';

const CLI = join(REPO_DIR, 'dist', 'cli', 'index.js');
const CHAT_REPLY = 'puffin-ledger-5512 is noted.';
const KEPT_BYTES = 'existed before the backup\n';
const LATER_BYTES = 'made after the backup\n';
const MODE_LOOSE = 0o644;
const MODE_PRIVATE = 0o600;
const NATIVE_TIMEOUT = 20000;

let nativeSkipped = null;

const modeOf = (path) => statSync(path).mode & 0o777;
const finding = (list, name) => list.find((f) => f.check === name);

/** Everything still alive whose command line carries this run's temp path. */
function carrying(path) {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(path))
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

/**
 * Stop the app that relaunched itself. It is a new process in a new process
 * group, so the driver's handle on the old one cannot reach it.
 */
async function stopRelaunched(base) {
  for (const p of carrying(base)) {
    try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 30 && carrying(base).length; i++) await sleep(100);
  for (const p of carrying(base)) {
    try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------- the system dialogs -- */
const SHEET = 'sheet 1 of window 1';
const appleString = (s) => JSON.stringify(s);

/** The app's main process, as System Events knows it. */
function electronMainPid(stateDir) {
  const flag = `--user-data-dir=${join(stateDir, '.chromium-profile')}`;
  const found = carrying(flag).find((p) => /Electron\.app\/Contents\/MacOS\/Electron\b/.test(p.command) && !/Helper/.test(p.command));
  return found ? found.pid : null;
}

const osa = (script) => execFileSync('/usr/bin/osascript', ['-e', script],
  { encoding: 'utf8', timeout: NATIVE_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function inApp(pid, lines) {
  return `tell application "System Events"\ntell (first process whose unix id is ${pid})\n`
    + `set frontmost to true\n${lines}\nend tell\nend tell`;
}

/** Why System Events cannot answer this app's dialogs here, or null. */
function nativeProblem(pid) {
  if (process.platform !== 'darwin') return 'the system dialogs are only driven on macOS';
  if (!pid) return 'could not find the app process for System Events';
  try {
    osa(inApp(pid, 'get name of every window'));
    return null;
  } catch (e) {
    return `System Events cannot reach the app (Accessibility permission for this terminal?): ${String(e.stderr || e.message).trim().slice(0, 200)}`;
  }
}

async function untilTrue(pid, expression, what, timeout = NATIVE_TIMEOUT) {
  const until = Date.now() + timeout;
  for (;;) {
    let last = '';
    try { last = osa(inApp(pid, `return ${expression}`)); } catch { /* not there yet */ }
    if (last === 'true') return;
    if (Date.now() > until) throw new Error(`gave up after ${timeout}ms waiting for ${what}`);
    await sleep(250);
  }
}

/** Go to a path in an open or save sheet. Key codes do not depend on the keyboard layout. */
async function goToPath(pid, path) {
  osa(inApp(pid, 'key code 5 using {command down, shift down}'));
  await sleep(1200);
  osa(inApp(pid, `set field to value of attribute "AXFocusedUIElement" of it\nset value of field to ${appleString(path)}`));
  await sleep(500);
  osa(inApp(pid, 'key code 36'));
  await sleep(1500);
}

async function saveAs(pid, dir, name) {
  await untilTrue(pid, `exists ${SHEET}`, 'the save dialog');
  await goToPath(pid, dir);
  osa(inApp(pid, `set value of text field 1 of ${SHEET} to ${appleString(name)}`));
  await sleep(400);
  await untilTrue(pid, `enabled of button "Save" of ${SHEET}`, 'the Save button');
  osa(inApp(pid, `click button "Save" of ${SHEET}`));
}

/** Pick the backup in the open sheet and return the words of the confirmation that follows. */
async function openAndReachConfirm(pid, file) {
  await untilTrue(pid, `exists ${SHEET}`, 'the open dialog');
  await goToPath(pid, file);
  await untilTrue(pid, `enabled of button "Open" of ${SHEET}`, 'the backup picked in the open dialog');
  osa(inApp(pid, `click button "Open" of ${SHEET}`));
  await untilTrue(pid, `exists button "Restore" of ${SHEET}`, 'the confirmation');
  return osa(inApp(pid, `return value of static texts of ${SHEET}`));
}

/* -------------------------------------------------------------- body -- */
async function waitWindowReady(app) {
  await app.waitFor(`!!document.querySelector('#entry')`, 'the composer', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('.cmodechip[data-id]:not([data-id=""])')`, 'the Mode chip', { timeout: 90000 });
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live', { timeout: 60000 });
}

/** The folders earlier restores set aside, next to the data folder. */
function replacedFolders(base) {
  return readdirSync(base).filter((n) => n.startsWith('state.before-restore-'));
}

function docRows(app) {
  return app.eval(`[...document.querySelectorAll('#settings .set-docrow')].map((r) => ({
    title: r.querySelector('.t').textContent.replace(/\\s+/g, ' ').trim(),
    text: r.textContent.replace(/\\s+/g, ' ').trim(),
  }))`);
}

/** The terminal half: doctor finds and fixes, a backup brings this moment back. */
async function terminalPart({ env, stateDir, base, workspace, config }) {
  /* Never synchronous: doctor calls the scripted model, which answers from this
     very process and cannot while Node is blocked waiting for doctor. */
  const atag = (...args) => new Promise((done, fail) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: workspace, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => {
      if (e && typeof e.code !== 'number') fail(e);
      else done({ code: e ? e.code : 0, out, err });
    });
  });

  // ---- doctor names a real problem and repairs it ---------------------------
  chmodSync(config, MODE_LOOSE);
  const found = await atag('doctor', '--json');
  check(found.code === 0, 'atag doctor finishes without a failing check', `exit ${found.code}: ${found.out}${found.err}`);
  const findings = JSON.parse(found.out);
  check(finding(findings, 'config')?.status === 'ok', 'doctor reads my config as valid', found.out);
  check(finding(findings, 'engine')?.status === 'ok', 'doctor reached my model server', found.out);
  check(finding(findings, 'config-mode')?.status === 'warn' && !!finding(findings, 'config-mode').fix,
    'doctor says other users can read my config.json, and offers a fix', found.out);
  check(modeOf(config) === MODE_LOOSE, 'looking changed nothing', modeOf(config).toString(8));

  const fixed = await atag('doctor', '--fix');
  check(fixed.code === 0 && /fixed\s+config-mode/.test(fixed.out), 'atag doctor --fix says it fixed it', fixed.out + fixed.err);
  check(modeOf(config) === MODE_PRIVATE, 'config.json really is private now', modeOf(config).toString(8));
  const clean = JSON.parse((await atag('doctor', '--json')).out);
  check(finding(clean, 'config-mode')?.status === 'ok' && !clean.some((f) => f.fix), 'a second doctor finds nothing left to fix', JSON.stringify(clean));

  // ---- a backup, then the folder changes -------------------------------------
  const kept = join(stateDir, 'kept-before-backup.txt');
  const later = join(stateDir, 'made-after-backup.txt');
  const archive = join(base, 'terminal-backup.tar.gz');
  writeFileSync(kept, KEPT_BYTES);
  const backup = await atag('data', 'backup', archive);
  check(backup.code === 0 && /backed up \d+ files/.test(backup.out), 'atag data backup says what it saved', backup.out + backup.err);
  check(existsSync(archive), 'the archive is on disk', archive);
  check(modeOf(archive) === MODE_PRIVATE, 'the archive is readable by me only: it holds my keys', modeOf(archive).toString(8));
  rmSync(kept);
  writeFileSync(later, LATER_BYTES);

  // ---- no confirmation, no restore -------------------------------------------
  const unconfirmed = await atag('data', 'restore', archive);
  check(unconfirmed.code === 2 && /--yes/.test(unconfirmed.out), 'a restore without confirmation asks for it', `exit ${unconfirmed.code}: ${unconfirmed.out}`);
  check(existsSync(later) && !existsSync(kept) && replacedFolders(base).length === 0, 'and changed nothing');

  // ---- confirmed --------------------------------------------------------------
  const restored = await atag('data', 'restore', archive, '--yes');
  check(restored.code === 0, 'atag data restore --yes finishes', `exit ${restored.code}: ${restored.out}${restored.err}`);
  check(existsSync(kept) && readFileSync(kept, 'utf8') === KEPT_BYTES, 'the file from before the backup is back, byte for byte');
  check(!existsSync(later), 'the file from after the backup is gone');
  const aside = replacedFolders(base);
  check(aside.length === 1 && existsSync(join(base, aside[0], 'made-after-backup.txt')),
    'nothing was deleted: the replaced folder is kept, with that file in it', JSON.stringify(aside));
  check(restored.out.includes(aside[0]), 'and the command says where it is', restored.out);
  check(modeOf(config) === MODE_PRIVATE && !!JSON.parse(readFileSync(config, 'utf8')), 'config.json came back whole and private', modeOf(config).toString(8));
}

/** Settings > Diagnostics > Doctor, by clicks. */
async function doctorInWindow(app, config) {
  chmodSync(config, MODE_LOOSE);
  await app.clickSel('.sb-settings');
  await app.waitFor(`!!document.querySelector('#settings')`, 'Settings open');
  await app.clickSel('#settings [data-act="settings:diagnostics"]');
  await app.waitFor(`!!document.querySelector('#settings [data-act="doctor:check"]')`, 'the Doctor row', { timeout: 20000 });
  await app.clickSel('#settings [data-act="doctor:check"]');
  await app.waitFor(`document.querySelectorAll('#settings .set-docrow').length > 0`, 'the findings listed', { timeout: 70000 });
  const rows = await docRows(app);
  app.log(`Doctor says: ${JSON.stringify(rows.map((r) => r.title))}`);
  check(rows.some((r) => r.title === 'OK config'), 'the window reports my config as fine', JSON.stringify(rows));
  const problem = rows.find((r) => r.title === 'Check config-mode');
  check(!!problem && /other users/.test(problem.text) && /Fix:/.test(problem.text), 'the window names the real problem and the fix', JSON.stringify(rows));
  check(modeOf(config) === MODE_LOOSE, 'Check on its own changed nothing', modeOf(config).toString(8));

  await app.clickSel('#settings [data-act="doctor:fix"]');
  await app.waitFor(`/Fixed what could be fixed/.test(document.querySelector('#settings').innerText)`, 'the Fix finishing', { timeout: 70000 });
  check(modeOf(config) === MODE_PRIVATE, 'the Fix button really changed the file', modeOf(config).toString(8));
  const after = await docRows(app);
  check(after.some((r) => r.title === 'OK config-mode'), 'the list now says so', JSON.stringify(after));
}

/** Settings > Diagnostics > Back up and Restore, through the real system dialogs. */
async function dataInWindow({ app, pid, stateDir, base }) {
  const kept = join(stateDir, 'kept-before-window-backup.txt');
  const later = join(stateDir, 'made-after-window-backup.txt');
  const dir = join(base, 'window-backups');
  const name = 'window-backup.tar.gz';
  const archive = join(dir, name);
  mkdirSync(dir);
  writeFileSync(kept, KEPT_BYTES);

  await app.clickSel('#settings [data-act="doctor:backup"]');
  await saveAs(pid, dir, name);
  await app.waitFor(`/backed up \\d+ files/.test(document.querySelector('#settings').innerText)`, 'Back up reporting what it saved', { timeout: 120000 });
  check(existsSync(archive), 'Back up wrote the file I chose', archive);
  check(modeOf(archive) === MODE_PRIVATE, 'the archive is readable by me only', modeOf(archive).toString(8));

  rmSync(kept);
  writeFileSync(later, LATER_BYTES);
  const asideBefore = replacedFolders(base).length;
  const notBusy = `!document.querySelector('#settings [data-act="doctor:restore"][disabled]')`;

  // ---- I change my mind at the confirmation ----------------------------------
  await app.clickSel('#settings [data-act="doctor:restore"]');
  const words = await openAndReachConfirm(pid, archive);
  app.log(`the confirmation says: ${JSON.stringify(words)}`);
  check(/Restore this backup/.test(words) && /terminal agent/.test(words), 'the app asks first, and says the terminal shares this folder', words);
  check(existsSync(later) && replacedFolders(base).length === asideBefore, 'nothing has changed while it asks');
  osa(inApp(pid, `click button "Cancel" of ${SHEET}`));
  await app.waitFor(notBusy, 'the Restore button free again', { timeout: 20000 });
  check(existsSync(later) && !existsSync(kept) && replacedFolders(base).length === asideBefore, 'Cancel left everything as it was');

  // ---- and this time I mean it -------------------------------------------------
  await app.clickSel('#settings [data-act="doctor:restore"]');
  await openAndReachConfirm(pid, archive);
  osa(inApp(pid, `click button "Restore" of ${SHEET}`));

  for (let i = 0; i < 240 && !(existsSync(kept) && !existsSync(later) && replacedFolders(base).length > asideBefore); i++) await sleep(250);
  check(existsSync(kept) && readFileSync(kept, 'utf8') === KEPT_BYTES, 'the file from before the backup is back, byte for byte');
  check(!existsSync(later), 'the file from after the backup is gone');
  const aside = replacedFolders(base).filter((n) => existsSync(join(base, n, 'made-after-window-backup.txt')));
  check(aside.length === 1, 'nothing was deleted: the replaced folder is kept, with that file in it', JSON.stringify(replacedFolders(base)));

  // ---- the app comes back by itself --------------------------------------------
  for (let i = 0; i < 120 && app.proc.exitCode === null && app.proc.signalCode === null; i++) await sleep(250);
  check(app.proc.exitCode !== null || app.proc.signalCode !== null, 'the old window closed for the relaunch');
  let window = false;
  for (let i = 0; i < 240 && !window; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
      window = list.some((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch { /* not listening yet */ }
    if (!window) await sleep(250);
  }
  check(window, 'the app came back on its own after the restore');
}

export const run = async () => {
  nativeSkipped = null;
  const result = await liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, workspace, base }) => {
    const config = join(stateDir, 'config.json');

    // ---- real history to protect: one finished chat ----------------------------
    model.script([reply(CHAT_REPLY)]);
    await ask(app, 'Please make a note of the ledger.');
    const turn = await waitTurn(app, { timeout: 60000, startGrace: 30000, quiet: 2500 });
    check(turn.reply === CHAT_REPLY, 'the chat finished', JSON.stringify(turn.reply.slice(0, 200)));

    // ---- close the app, use the terminal ------------------------------------------
    /* `data restore` says to close every window first. */
    await app.close();
    await terminalPart({ env: { ...process.env, ...app.opts.env, ATOMIC_AGENT_STATE_DIR: stateDir }, stateDir, base, workspace, config });

    // ---- open the app on the restored folder ----------------------------------------
    const again = await launch(app.opts);
    try {
      await waitWindowReady(again);
      await again.waitFor(`!!document.querySelector('#sidebar .sesrow[data-ses]')`, 'the restored chat in the sidebar', { timeout: 60000 });
      await again.clickSel('#sidebar .sesrow[data-ses]');
      await again.waitFor(`[...document.querySelectorAll('#content .turn')].some((n) => n.innerText.includes(${JSON.stringify(CHAT_REPLY)}))`,
        'the restored chat, with its reply', { timeout: 30000 });

      await doctorInWindow(again, config);

      const pid = electronMainPid(stateDir);
      nativeSkipped = nativeProblem(pid);
      if (nativeSkipped) {
        again.log(`not driving Back up and Restore in the window: ${nativeSkipped}`);
      } else {
        await dataInWindow({ app: again, pid, stateDir, base });
        await stopRelaunched(base);
      }
    } catch (e) {
      try { await again.screenshot(join(base, 'failure-second-window.png')); } catch { /* the window may be gone */ }
      writeFileSync(join(base, 'app-output-second-window.log'), again.output());
      throw e;
    } finally {
      await again.close();
    }
  });
  if (result.ok && !result.skipped && nativeSkipped) {
    return { ...result, skipped: `terminal and Doctor passed, but the Back up and Restore buttons were not driven: ${nativeSkipped}` };
  }
  return result;
};

if (import.meta.url === `file://${process.argv[1]}`) main(run());
