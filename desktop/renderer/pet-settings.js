/* ---------------- ATO-2741: the desktop pet's switch in the main window ----------------
   Loaded before renderer.js; declares only. The renderer half reads
   renderer.js globals (BR, render, PAL, toast) at call time.

   The pet (ATO-2391) could only be turned on from View › Desktop Pet ›
   Show Pet, and Windows may have no menu bar. Two more ways in, as Codex's
   pet and VS Code / Raycast put a toggle both in Settings and in the
   command palette:

   - Settings › General › Desktop pet: a switch;
   - the ⌘K palette (Ctrl+K on Windows and Linux): "Show desktop pet" or
     "Hide desktop pet", whichever applies now.

   Both go through main's own toggle (pet:setEnabled → PetHub.setEnabled,
   main/pet-ipc.ts), the one the menu checkbox uses. Main sends every change
   back (pet:prefsChanged), whoever made it, so the switch, the palette row
   and the menu checkbox always agree. */

const PET_PAL_ACT = 'petset:toggle';

/** The palette row's words for the pet as it is now (on: it is showing). */
function petPaletteTitle(on) {
  return on ? 'Hide desktop pet' : 'Show desktop pet';
}

/** The Settings row. `st.info` is main's answer ({enabled, dnd}) or null; `h` has esc and setSwitchHTML. */
function petSettingsRowHTML(st, h) {
  const info = st.info;
  const on = !!(info && info.enabled);
  const desc = 'A small atom that sits over your other apps and shows what the agent is doing. When the agent asks before a step, you can allow it once or deny it from there. It never calls a model.';
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Desktop pet</div>'
      + '<div class="d">' + h.esc(desc) + '</div>'
      + (st.error ? '<div class="tk-help tk-help--warn" role="status">' + h.esc(st.error) + '</div>' : '')
    + '</div>'
    + h.setSwitchHTML({on, busy: st.busy, disabled: !info || st.busy, act: PET_PAL_ACT,
      label: 'Desktop pet', title: on ? 'Hide the desktop pet' : 'Show the desktop pet'})
  + '</div>';
}

/** The palette's row for the pet, found in a PAL-shaped catalogue; its title follows `on`. */
function petPaletteSync(pal, on) {
  if (!Array.isArray(pal)) return false;
  for (const group of pal) {
    const rows = Array.isArray(group) ? group[1] : null;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) if (Array.isArray(r) && r[4] === PET_PAL_ACT) { r[1] = petPaletteTitle(on); return true; }
  }
  return false;
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const PETSET = {info: null, busy: false, error: null};

function petSetApply(r) {
  if (r && typeof r === 'object' && typeof r.enabled === 'boolean') {
    PETSET.info = {enabled: r.enabled, dnd: r.dnd === true};
    PETSET.error = null;
  }
  if (typeof PAL !== 'undefined') petPaletteSync(PAL, !!(PETSET.info && PETSET.info.enabled));
}

/** Settings › General was entered, and once at boot: read the pet's state. */
function petSettingsRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.petPrefs) return;
  BR.petPrefs().then((r) => { petSetApply(r); render(); }).catch(() => {});
}

/** The row's and the palette's act: show the pet when it is hidden, hide it when it shows. */
function petSettingsAct(v) {
  if (v !== 'toggle' || typeof BR === 'undefined' || !BR || !BR.petSetEnabled || PETSET.busy) return;
  const next = !(PETSET.info && PETSET.info.enabled);
  PETSET.busy = true; PETSET.error = null; render();
  BR.petSetEnabled(next)
    .then((r) => {
      PETSET.busy = false;
      if (r && typeof r.enabled === 'boolean') petSetApply(r);
      else PETSET.error = 'The desktop pet could not be changed. Try again.';
      render();
    })
    .catch(() => { PETSET.busy = false; PETSET.error = 'The desktop pet could not be changed. Try again.'; render(); });
}

/** Called once at boot (renderer.js, beside quickEntryBoot): follow changes made anywhere. */
function petSettingsBoot() {
  if (typeof BR === 'undefined' || !BR) return;
  if (BR.onPetPrefs) BR.onPetPrefs((r) => { petSetApply(r); render(); });
  petSettingsRefresh();
}

if (typeof module !== 'undefined') module.exports = {PET_PAL_ACT, petPaletteTitle, petSettingsRowHTML, petPaletteSync};
