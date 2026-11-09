/* ATO-1044 — "Getting the best model for this computer, 42%", then the ask.

   After the starter model (starter-chat.js) the app downloads the model this
   computer can really carry (main/upgrade-model.ts, app:upgradeModel). While
   it comes, one strip above the composer says how far it is; the chat keeps
   working on the starter. Once it is on disk the strip asks: Switch now /
   Later. The switch is the person's click, never silent (Nadya, ATO-1044);
   a turn in flight holds it until the turn ends. */

const UPGRADE = { phase: null, id: null, name: null, sizeLabel: null, percent: null, error: null, held: false };

/** Plain name: "Gemma 4 26B" out of "Gemma 4 26B A4B GGUF". */
function upgradeName() {
  return String(UPGRADE.name || UPGRADE.id || 'the bigger model').replace(/\s+GGUF$/i, '');
}

function upgradeShown() {
  return !!UPGRADE.phase && UPGRADE.phase !== 'done';
}

function upgradeNoticeHTML() {
  if (!upgradeShown()) return '';
  const p = UPGRADE.phase;
  const name = upgradeName();
  let icon = 'download';
  let tone = '';
  let text = '';
  let buttons = '';
  if (p === 'downloading') {
    text = 'Getting the best model for this computer: ' + name
      + (UPGRADE.percent != null ? ', ' + UPGRADE.percent + '%' : '')
      + '. Chats keep running on the small model meanwhile.';
    buttons = '<span class="upg-bar" aria-hidden="true"><span style="width:' + (UPGRADE.percent || 0) + '%"></span></span>';
  } else if (p === 'ready') {
    icon = 'check'; tone = ' ok';
    text = name + ' is ready. It answers better than the small model.';
    buttons = '<button class="btn btn-p xs" data-act="upg:switch">Switch now</button>'
      + '<button class="btn btn-g xs" data-act="upg:later">Later</button>';
  } else if (p === 'switching') {
    icon = 'refresh';
    text = 'Switching to ' + name + '…';
  } else if (p === 'switched') {
    icon = 'check'; tone = ' ok';
    text = UPGRADE.held
      ? name + ' takes over when the current reply finishes.'
      : 'Now on ' + name + '.';
    buttons = '<button class="iconbtn sm" data-act="upg:dismiss" aria-label="Dismiss" title="Dismiss">' + ic('x') + '</button>';
  } else if (p === 'failed') {
    icon = 'alert'; tone = ' warn';
    text = (UPGRADE.switching ? 'Could not switch to ' : 'Could not download ') + name
      + (UPGRADE.error ? ': ' + UPGRADE.error : '') + '. The small model keeps working.';
    buttons = '<button class="iconbtn sm" data-act="upg:dismiss" aria-label="Dismiss" title="Dismiss">' + ic('x') + '</button>';
  }
  return '<div class="statusstrip upgrade-strip" role="status" data-upgrade="' + esc(p) + '">'
    + '<span class="ss-ic' + tone + '">' + ic(icon) + '</span>'
    + '<span class="ss-text">' + esc(text) + '</span>' + buttons + '</div>';
}

function upgradeOnEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.id && ev.id !== UPGRADE.id) UPGRADE.percent = null;
  UPGRADE.id = ev.id || UPGRADE.id;
  UPGRADE.name = ev.name || UPGRADE.name;
  UPGRADE.sizeLabel = ev.sizeLabel || UPGRADE.sizeLabel;
  UPGRADE.phase = ev.phase || null;
  UPGRADE.error = ev.error || null;
  UPGRADE.held = !!ev.held;
  UPGRADE.switching = !!ev.switching;
  if (UPGRADE.phase === 'done') UPGRADE.phase = null;
  if (UPGRADE.phase === 'switched' && typeof refreshLiveConfig === 'function') refreshLiveConfig().catch(() => {});
  render();
}

function upgradeOnPull(ev) {
  if (!ev || UPGRADE.phase !== 'downloading' || ev.id !== UPGRADE.id) return;
  if (typeof ev.percent === 'number') {
    const pct = Math.round(ev.percent);
    if (pct !== UPGRADE.percent) { UPGRADE.percent = pct; render(); }
  }
}

/** A window that loads after main said where the upgrade stands asks once (app:upgradeGet). */
function upgradeCatchUp() {
  if (typeof BR === 'undefined' || !BR || !BR.upgradeGet) return;
  BR.upgradeGet().then((ev) => { if (ev && !UPGRADE.phase) upgradeOnEvent(ev); }).catch(() => {});
}

/** The strip's buttons (renderer.js act dispatch). Answers whether the act was ours. */
function upgradeAct(a) {
  if (a === 'upg:switch') {
    if (!BR || !BR.upgradeSwitch) return true;
    UPGRADE.phase = 'switching'; render();
    BR.upgradeSwitch().catch((err) => upgradeOnEvent({ id: UPGRADE.id, phase: 'failed', switching: true, error: String(err && err.message || err) }));
    return true;
  }
  if (a === 'upg:later') {
    UPGRADE.phase = null; render();
    if (BR && BR.upgradeLater) BR.upgradeLater().catch(() => {});
    return true;
  }
  if (a === 'upg:dismiss') { UPGRADE.phase = null; render(); return true; }
  return false;
}

if (typeof module !== 'undefined') module.exports = { UPGRADE, upgradeOnEvent, upgradeOnPull, upgradeShown, upgradeAct, upgradeNameForTest: upgradeName };
