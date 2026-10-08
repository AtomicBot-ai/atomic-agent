"use strict";

// Separate provider/engine and model choices on each composer seat.
function composerEngineId() { return llmManaged().engine === 'atomic-core' ? 'atomic-core' : 'llama-server'; }
function composerEngineName(id) { return id === 'atomic-core' ? 'Atomic Chat' : 'Local llama'; }
function composerSeatLocal(seat) { return seat.provider === 'local-llama'; }
function composerEngineMark(id, size) {
  return id === 'atomic-core' ? logoHTML('atomicchat', size, 'server') : providerMark('llama.cpp', size);
}
function composerEngineChip(kind, label, local, role) {
  const title = (role ? role + ' inference engine: ' : 'Inference engine: ') + label;
  return '<button class="cchip providerchip enginechip' + cchipOpen(kind) + '" data-sel-open="' + kind + '" data-id="' + esc(label) + '"'
    + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">'
    + (local ? composerEngineMark(composerEngineId(), 'xs') : providerMark(label, 'xs'))
    + '<span class="cval">' + esc(local ? label : providerWord(label)) + '</span>' + ic('chevD', 'chev') + '</button>';
}
function composerLocalEngineRows(leg) {
  const rm = rmNow();
  const seat = leg === 'worker' ? rm.workerProviderId : rm.orchestratorProviderId;
  return ['llama-server', 'atomic-core'].map((engine) => ({
    type:'localEngine', id:engine, label:composerEngineName(engine), leg,
    detail: engine === 'atomic-core' ? 'Atomic Chat Core · runs on this machine' : 'llama.cpp · runs on this machine',
    active: (!leg || seat === 'local-llama') && composerEngineId() === engine,
  }));
}
function composerFusionEngineRows(leg) {
  const rm = rmNow();
  const chosen = leg === 'worker' ? rm.workerProviderId : rm.orchestratorProviderId;
  const other = leg === 'worker' ? rm.orchestratorProviderId : rm.workerProviderId;
  const cloud = selProviders().filter((p) => p.id !== other).map((p) => ({
    type:'fusionLeg', leg, id:p.id, label:p.id,
    detail: BSW.readyIds.includes(p.id) ? 'Cloud provider' : 'No API key', active:p.id === chosen,
  }));
  // There is one managed local slot. The swap control moves it between roles.
  return cloud.concat(other === 'local-llama' ? [] : composerLocalEngineRows(leg),
    [{type:'action', id:'add', label:'Add a new provider', detail:'opens the wizard', active:false}]);
}
function composerModelSeat() {
  return selBackend() === 'fusion' ? (SEL.kind === 'workers' ? 'worker' : 'orchestrator') : null;
}
function composerModelProvider() {
  const leg = composerModelSeat();
  return leg ? fzSeats()[leg === 'worker' ? 'works' : 'plans'].provider : selActiveProviderId();
}
function composerSeatModelRows() {
  const leg = composerModelSeat();
  const id = composerModelProvider();
  const seat = fzSeats()[leg === 'worker' ? 'works' : 'plans'];
  if (id === 'local-llama') {
    return [{type:'action', id:'downloadMore', label:'Download more models…', detail:'opens Settings › Models', active:false}]
      .concat(selLocalMatches().filter((m) => m.downloaded).map((m) => ({
        type:'seatModel', leg, id:m.id, label:llmModelName(m), detail:'On this machine', active:m.id === seat.label,
      })));
  }
  return SEL.models.filter((m) => !SEL.filter || modelMatches(m.id, '', SEL.filter)).map((m) => ({
    type:'seatModel', leg, id:m.id, label:m.id, detail:m.contextWindow ? fmtContextWindow(m.contextWindow) + ' context' : '', active:m.id === seat.label,
  }));
}
async function composerPickEngine(row) {
  const held = restartStopsTurn();
  if (held) { restartRefusedToast(held); return; }
  SEL.busy = true; SEL.err = null; render();
  const result = await swxRun('Changing inference engine…', {}, () => SWXBR.composerEngine(row.id, row.leg));
  SEL.busy = false;
  if (!result || !result.ok) { SEL.err = result && (result.error || result.refusal) || 'Could not change the engine'; render(); return; }
  SEL.kind = row.leg === 'worker' ? 'workers' : 'model'; SEL.filter = ''; SEL.cursor = 0;
  await refreshLiveConfig(); render(); selEnterModelPane();
}
async function composerPickSeatModel(row) {
  const held = restartStopsTurn();
  if (held) { restartRefusedToast(held); return; }
  const before = fzBefore('Selecting model…');
  const want = row.leg === 'worker' ? {worker:{provider:composerModelProvider(), label:row.id}} : {model:row.id};
  fzAfter(await swxRun('Selecting model…', want, () => SWXBR.fusionModel(row.leg, row.id)), before);
}
