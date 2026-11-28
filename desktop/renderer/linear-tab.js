/* ---------------- Settings › Connections › Linear: the window's glue (ATO-2464) ----------------
   Loaded AFTER renderer.js (like mini-chat-handoff.js), so it may use the
   renderer's bridge and helpers (BR, memStateDir, applyStatus, $, S,
   paneRepaintKeepFocus, logoHTML). renderer.js only routes to the
   functions below; nothing calls them before the window has loaded.
   The key and the webhook signing secret go to the key store through
   app:dotenvSet (checked with Linear first, main/linear-key-check.ts), the
   `channels.linear` block through one config write; the agent reads them when
   it starts, so each change owes a restart, as on the Discord tab. */
const LN = createLinearSettings({
  readConfig: () => BR ? BR.configGetKey('channels') : {ok:false},
  secretsPresent: async () => {
    if (!BR) return {ok:false};
    const names = [LINEAR_KEY_ENV, LINEAR_SECRET_ENV];
    const stateDir = memStateDir();
    const [env, dotenv] = await Promise.all([BR.envPresent(names), stateDir ? BR.dotenvKeys(stateDir) : Promise.resolve({ok:true, keys:[]})]);
    if (dotenv && dotenv.ok === false) return {ok:false};
    const has = (n) => (Array.isArray(env) && env.includes(n)) || (!!dotenv && Array.isArray(dotenv.keys) && dotenv.keys.includes(n));
    return {ok:true, names:names.filter(has)};
  },
  setSecret: (name, v) => { const stateDir = memStateDir(); return BR && stateDir ? BR.dotenvSet(stateDir, name, v) : {ok:false}; },
  checkKey: (v) => BR && BR.linearCheckKey ? BR.linearCheckKey(v) : {ok:false, reason:'unreachable'},
  write: (block) => BR ? BR.configSetPath('channels.linear', block) : {ok:false},
  restart: async () => { const st = await BR.restart(); try { applyStatus(st); } catch (e) { /* the status still says how it went */ } return st; },
  restartBlocked: () => restartStopsTurn(),
  agentGen: () => AGENT_GEN,
});
function linearVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'linear'; }
function linearTab() {
  const st = LN.state;
  return linearPaneHTML(st, {status:lnStatus(st, LN.restartOwed()), mode:lnMode(st.cfg, st.hasSecret), mention:lnMention(st.cfg),
    owed:LN.restartOwed(), stale:st.msgGen !== AGENT_GEN}, {esc, ic, logo: logoHTML});
}
function lnRepaint() { if (linearVisible()) paneRepaintKeepFocus(linearTab()); }
function linearTabEntered() { LN.entered().then(lnRepaint); lnRepaint(); }
async function linearAct(what) {
  const [verb] = what.split(':');
  const arg = what.slice(verb.length + 1);
  const run = async (p) => { lnRepaint(); await p; lnRepaint(); };
  // Remove key / secret / an owner take a second click on the same button; any other action disarms them.
  if (verb === 'clearKey' || verb === 'clearSecret' || verb === 'removeOwner') {
    if (!LN.arm(verb === 'removeOwner' ? 'removeOwner:' + arg : verb)) { lnRepaint(); return; }
    return run(verb === 'clearKey' ? LN.clearKey() : verb === 'clearSecret' ? LN.clearSecret() : LN.removeOwner(arg));
  }
  LN.disarm();
  const focus = (id) => { const n = $('#' + id); if (n) n.focus(); };
  if (verb === 'key') { LN.openKey(); lnRepaint(); focus('ln-key'); return; }
  if (verb === 'secret') { LN.openSecret(); lnRepaint(); focus('ln-secret'); return; }
  if (verb === 'cancel') { LN.cancelPrompt(); lnRepaint(); return; }
  if (verb === 'keySave') { const n = $('#ln-key'); await run(LN.saveKey(n ? n.value : '')); if (LN.state.mode === 'keyPrompt') focus('ln-key'); return; }
  if (verb === 'secretSave') { const n = $('#ln-secret'); await run(LN.saveSecret(n ? n.value : '')); if (LN.state.mode === 'secretPrompt') focus('ln-secret'); return; }
  if (verb === 'mode') { await run(LN.setMode(arg)); if (LN.state.mode === 'secretPrompt') focus('ln-secret'); return; }
  if (verb === 'addOwner') return run(LN.addOwner());
  if (verb === 'mentionSave') return run(LN.saveMention());
  if (verb === 'enable') return run(LN.setEnabled(!LN.state.cfg.enabled));
  if (verb === 'restart') return run(LN.restart());
  if (verb === 'refresh') return run(LN.refresh());
  if (verb === 'keysPage') { if (BR && BR.openExternal) BR.openExternal(LN_KEYS_URL); return; }
}
function linearKey(e, k) {
  const id = e.target && e.target.id;
  const enter = {'ln-key':'keySave', 'ln-secret':'secretSave', 'ln-owner':'addOwner', 'ln-mention':'mentionSave'}[id];
  if (enter && k === 'Enter') { e.preventDefault(); linearAct(enter); return true; }
  if ((id === 'ln-key' || id === 'ln-secret') && k === 'Escape') { e.preventDefault(); linearAct('cancel'); return true; }
  return false;
}
