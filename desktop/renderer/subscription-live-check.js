/* ---------------- ATO-1684: is the subscription CLI really signed in? ----------------
   Add provider's Claude Code / Codex step reads the CLI's login file first
   (wizSubStatus, main/subscription-cli-detect.ts). That file cannot tell an
   expired login from a good one, and on macOS Claude Code keeps the token in
   the Keychain, so a dead login used to show up only on the first message.
   Now, once the file says the CLI is installed, the step also asks the CLI
   itself, once (main/subscription-cli-live-check-ipc.ts: `claude auth status`
   or `codex login status`; a tiny one-turn call only for a Claude Code too
   old to have the status command). Main keeps the answer for the app's
   session, so picking the row again does not run it again.

   States: checking (a small line, nothing blocks), signed in, not signed in
   (the step's Sign in button and the exact command, as before), and check
   failed or CLI not found by the check (the file's answer stands: never
   block on an unknown).

   Loaded before renderer.js; it reads BR, WIZ and render only when a
   function runs. renderer.js calls in through `typeof` guards, so its unit
   slices run without this file. The pure part is exported for the unit suite. */

/** cli -> {checking, check}: check is the last finished answer, or null. */
const SUB_LIVE = new Map();
/** CLIs whose next ask runs again ("Check again"). */
const SUB_LIVE_FORCE = new Set();
/** While the sign-in poll waits, a known signed-out CLI is asked again at most this often. */
const SUB_LIVE_RECHECK_MS = 15000;
/** ATO-2463: cli -> callbacks waiting for the next finished answer (subLiveWhenDone). */
const SUB_LIVE_WAITERS = new Map();

/** The file's status with the live answer laid over it. Pure. */
function subLiveMerge(file, live) {
  if (!file || file.installed !== true || !live) return file;
  const check = live.check;
  const out = Object.assign({}, file);
  if (live.checking) out.checking = true;
  if (!check) return out;
  if (check.state === 'signed_in') { out.signedIn = true; out.apiKeyLogin = false; out.liveChecked = true; }
  else if (check.state === 'signed_out') { out.signedIn = false; out.apiKeyLogin = !!(check.apiKeyLogin || file.apiKeyLogin); out.liveChecked = true; }
  else if (!live.checking) out.liveFailed = true;
  return out;
}

/** Ask main (once per CLI unless forced) and draw the step again when the answer lands. */
function subLiveAsk(cli, force) {
  if (!cli || typeof BR === 'undefined' || !BR || !BR.subscriptionLiveCheck) return;
  const cur = SUB_LIVE.get(cli);
  if (cur && cur.checking) return;
  if (cur && !force) return;
  SUB_LIVE.set(cli, {checking: true, check: cur ? cur.check : null, askedAt: Date.now()});
  const repaint = () => {
    if (typeof WIZ !== 'undefined' && WIZ.row && WIZ.row.subscriptionCli === cli && typeof render === 'function') render();
  };
  Promise.resolve(BR.subscriptionLiveCheck(cli, !!force))
    .then((r) => {
      const prev = SUB_LIVE.get(cli);
      const check = r && r.ok && r.check ? r.check : {cli, state: 'failed', via: 'none', fix: null};
      SUB_LIVE.set(cli, {checking: false, check, askedAt: prev ? prev.askedAt : Date.now()});
      repaint();
      subLiveFlush(cli, check);
    })
    .catch(() => {
      const prev = SUB_LIVE.get(cli);
      SUB_LIVE.set(cli, {checking: false, check: {cli, state: 'failed', via: 'none', fix: null}, askedAt: prev ? prev.askedAt : Date.now()});
      repaint();
      subLiveFlush(cli, SUB_LIVE.get(cli).check);
    });
}

/** ATO-2463: run fn(check) with the finished answer: now when one is known, else when the running ask lands. */
function subLiveWhenDone(cli, fn) {
  const cur = SUB_LIVE.get(cli);
  if (cur && !cur.checking && cur.check) { fn(cur.check); return; }
  const list = SUB_LIVE_WAITERS.get(cli) || [];
  list.push(fn);
  SUB_LIVE_WAITERS.set(cli, list);
}
function subLiveFlush(cli, check) {
  const list = SUB_LIVE_WAITERS.get(cli);
  if (!list) return;
  SUB_LIVE_WAITERS.delete(cli);
  for (const fn of list) { try { fn(check); } catch (e) { /* one waiter's failure does not stop the others */ } }
}

/** wizSubStatus's answer: the file's status, merged with the live one, which it starts once. */
function subLiveStatus(cli, file) {
  if (file && file.installed === true) {
    const force = SUB_LIVE_FORCE.delete(cli);
    subLiveAsk(cli, force);
  }
  return subLiveMerge(file, SUB_LIVE.get(cli));
}

/** "Check again": the next ask runs the CLI again. */
function subLiveForget(cli) {
  if (!cli) return;
  if (SUB_LIVE.has(cli)) SUB_LIVE_FORCE.add(cli);
}

/**
 * The sign-in poll's brake: the login file can say signed in while the CLI
 * itself said no (an expired login keeps its file). Then the poll does not
 * move on; it asks the CLI again, at most every SUB_LIVE_RECHECK_MS, and
 * moves on once that says signed in.
 */
function subLiveHoldsSignedOut(cli) {
  const cur = SUB_LIVE.get(cli);
  if (!cur || !cur.check || cur.check.state !== 'signed_out') return false;
  if (!cur.checking && Date.now() - (cur.askedAt || 0) >= SUB_LIVE_RECHECK_MS) subLiveAsk(cli, true);
  return true;
}

/** The step's extra small line for the live check, or null. */
function subLiveLine(st, service, cli) {
  if (!st || st.installed !== true) return null;
  if (st.checking && !st.liveChecked) return {small: true, text: 'Checking that ' + service + ' is signed in…'};
  if (st.liveFailed) return {small: true, text: 'Could not check the ' + service + ' sign-in just now. You can go on; if the first answer says you are signed out, run ' + (cli === 'codex' ? 'codex login' : 'claude') + '.'};
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = {SUB_LIVE, SUB_LIVE_FORCE, SUB_LIVE_RECHECK_MS, SUB_LIVE_WAITERS, subLiveMerge, subLiveAsk, subLiveWhenDone, subLiveStatus, subLiveForget, subLiveHoldsSignedOut, subLiveLine};
}
