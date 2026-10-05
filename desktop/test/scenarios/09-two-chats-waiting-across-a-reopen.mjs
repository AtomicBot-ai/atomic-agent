/**
 * 09 — two chats waiting on approvals, the window closed and opened again.
 *
 * The person: asks for something that needs permission in one chat, starts
 * a new chat with ⌘N and asks for another such thing there, so two cards
 * wait at once. They close the window (⌘W) and bring it back from the Dock.
 *
 * The human result (B01 / ATO-198 / ATO-208): the reopened window has taken
 * the running turns over (agent:liveTurns) and replayed the approvals after
 * that, so each chat is still its own row in the sidebar, opens on its own
 * message, and shows its own card, which still answers: Allow once there
 * writes that chat's file and only that one.
 *
 * Why it is SKIPPED by default: closing the window and reopening it from the
 * Dock are gestures CDP cannot make. `Input.dispatchKeyEvent` goes to the
 * page, not to the native menu, so a driven ⌘W reaches no Close Window (and
 * the page has no control of its own that closes the window); and nothing in
 * the page can raise the app's `activate`, which only a Dock click or a
 * relaunch of the bundle does. Doing either from outside means System
 * Events: Accessibility permission for whatever runs node, and an `open -a`
 * of the dev Electron bundle that reaches whichever Electron app LaunchServices
 * picks, so another Electron app running on the machine (another lane's run)
 * could receive it. That path is written below and runs only with
 * ATAG_TEST_REOPEN=1, on a machine where this is the only Electron app up.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_DIR } from '../drive.mjs';
import {
  scenario, main, ask, waitTurn, chooseMode, check, modelDidNot, sleep, MOD_KEY, CDP_PORT, SCENARIO_NAME,
} from '../harness.mjs';

const OPT_IN = process.env.ATAG_TEST_REOPEN === '1' && process.platform === 'darwin';
const CHATS = [
  { tag: 'alpha-09', file: 'alpha.txt' },
  { tag: 'bravo-09', file: 'bravo.txt' },
];

/** Every process on this Mac, as {pid, ppid, command}. Plain `ps`. */
function processes() {
  const out = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 << 20 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}
/** The Electron main process under the shim we spawned — the app a person sees in the Dock. */
function electronMain(shimPid) {
  const all = processes();
  const by = new Map(all.map((p) => [p.pid, p]));
  const under = (pid) => { for (let c = by.get(pid), h = 0; c && h < 40; h++) { if (c.pid === shimPid) return true; c = by.get(c.ppid); } return false; };
  return all.find((p) => /Electron\.app\/Contents\/MacOS\/Electron\b/.test(p.command) && !/Helper/.test(p.command) && under(p.pid)) || null;
}
const osa = (script) => execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
/** Is there a page (a window) on the debugging port right now? Looking only. */
async function hasWindow() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.some((t) => t.type === 'page');
  } catch { return false; }
}

/** The chat on screen, as a person reads it: its row, my messages, the card. */
const onScreen = (app) => app.eval(`(() => ({
  row: (document.querySelector('.sesrow.on[data-ses]') || { dataset: {} }).dataset.ses || null,
  mine: [...document.querySelectorAll('#content .turn.usr')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()),
  cards: [...document.querySelectorAll('#scroller .appr:not(.done)')].length,
  receipts: [...document.querySelectorAll('#scroller .appr.done .apprlbl b')].map((n) => n.textContent.trim()),
}))()`);

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  await chooseMode(app, 'default');

  // ---- two chats, each with a card waiting ---------------------------------
  const ids = [];
  for (const [i, c] of CHATS.entries()) {
    if (i > 0) {
      await app.press('n', [MOD_KEY]);   // ⌘N, New chat — handled by the page's own keys
      await app.waitFor(`document.querySelectorAll('#content .turn').length === 0`, 'a new, empty chat', { timeout: 15000 });
    }
    await ask(app, `Using a shell command, create a file called ${c.file} here whose only contents are the `
      + `single line "${c.tag}". Use the shell for this, not anything else. Then tell me it is done.`);
    const t = await waitTurn(app, { timeout: 240000, approve: 'none' });
    if (!t.pending) modelDidNot(`ask before writing ${c.file}`, JSON.stringify(t.reply.slice(0, 200)));
    await app.waitFor(`!!document.querySelector('.sesrow.on[data-ses]')`, `chat ${i + 1}'s own row in the sidebar`, { timeout: 30000 });
    ids.push((await onScreen(app)).row);
  }
  check(ids[0] && ids[1] && ids[0] !== ids[1], 'two chats, each with its own row', JSON.stringify(ids));
  check(!existsSync(join(workspace, CHATS[0].file)) && !existsSync(join(workspace, CHATS[1].file)),
    'neither file exists — both calls are waiting for me');

  // ---- close the window, bring it back from the Dock ------------------------
  const proc = electronMain(app.proc.pid);
  check(!!proc, 'found the app process a person sees in the Dock');
  osa(`tell application "System Events" to set frontmost of (first process whose unix id is ${proc.pid}) to true`);
  await sleep(500);
  osa('tell application "System Events" to keystroke "w" using command down');
  for (let i = 0; i < 50 && (await hasWindow()); i++) await sleep(200);
  check(!(await hasWindow()), 'the window is closed (⌘W), the app still running');
  check(processes().some((p) => p.pid === proc.pid), 'the app itself did not quit');
  await sleep(1500);
  /* A Dock click is a reopen event for the running bundle; `open -a` of the
     same bundle sends exactly that to the app already running. */
  execFileSync('/usr/bin/open', ['-a', join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app')]);
  for (let i = 0; i < 100 && !(await hasWindow()); i++) await sleep(200);
  check(await hasWindow(), 'the window came back from the Dock');
  await app.reconnect();
  await app.waitFor(`!!document.querySelector('#entry')`, 'the reopened window', { timeout: 60000 });

  // ---- each chat: its row, its message, its card -----------------------------
  for (const [i, c] of CHATS.entries()) {
    await app.waitFor(`!!document.querySelector('.sesrow[data-ses="${ids[i]}"]')`, `chat ${i + 1}'s row after the reopen`, { timeout: 60000 });
    await app.clickSel(`.sesrow[data-ses="${ids[i]}"]`);
    await app.waitFor(`[...document.querySelectorAll('#content .turn.usr')].some((n) => n.innerText.includes(${JSON.stringify(c.tag)}))`
      + ` && !!document.querySelector('#scroller .appr:not(.done)')`,
      `chat ${i + 1} open on its own message and its card`, { timeout: 60000 });
    const s = await onScreen(app);
    const other = CHATS[1 - i].tag;
    check(s.row === ids[i], `chat ${i + 1}'s row is the one lit`, JSON.stringify(s.row));
    check(s.mine.some((m) => m.includes(c.tag)) && !s.mine.some((m) => m.includes(other)),
      `chat ${i + 1} shows its own message and not the other chat's`, JSON.stringify(s.mine));
    check(s.cards === 1, `chat ${i + 1} shows exactly one waiting card — its own`, `${s.cards} open cards`);
  }

  // ---- and the replayed cards still answer -------------------------------------
  for (const [i, c] of CHATS.entries()) {
    await app.clickSel(`.sesrow[data-ses="${ids[i]}"]`);
    await app.waitFor(`!!document.querySelector('#scroller .appr:not(.done) [data-appr="y"]')`, `chat ${i + 1}'s card`, { timeout: 30000 });
    await app.clickText('Allow once', { scope: '#scroller .appr:not(.done)' });
    for (let k = 0; k < 120 && !existsSync(join(workspace, c.file)); k++) await sleep(500);
    check(existsSync(join(workspace, c.file)), `Allow once in chat ${i + 1} wrote ${c.file}`);
    check(readFileSync(join(workspace, c.file), 'utf8').trim() === c.tag, `${c.file} holds “${c.tag}”`);
    if (i === 0) check(!existsSync(join(workspace, CHATS[1].file)), `and only ${c.file}: the other chat's call still waits`);
  }
}, OPT_IN ? {} : {
  skip: 'closing the window (⌘W) and reopening it from the Dock cannot be driven through CDP; '
    + 'set ATAG_TEST_REOPEN=1 to drive them with System Events (needs Accessibility permission, and no other Electron app running)',
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
