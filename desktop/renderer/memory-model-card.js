/* ---------------- the memory model's card (ATO-900 item 5) ----------------
   Loaded before renderer.js; declares only.

   Settings › Models › Embedding models. A click on the memory model
   (EmbeddingGemma and the rest) used to show nothing on the card: the result
   went to the status line at the top of the pane, and the row lit up only
   once its server answered, so a pick that left the server for later looked
   like nothing happened. The card now says its own state, where the person
   is looking, with the chat cards' visual language (the selected radio, a
   status chip, a line under the blurb):

     Starting…        while the click's step runs, or the server loads
     Running          memory search uses this model now
     Not running      picked and on, its server is not up (the row's Start)
     Off              picked, local memory search is off (the row's Turn on)
     Not downloaded   picked, its file is not on disk (the row's Download)
     Failed           the step failed: the reason and Retry
     Not answering    its server is up and does not answer
     Engine not ready the local engine is missing or broken: Download again

   A card the person has not picked and that is not busy says nothing more
   than its Use / Download pill. renderer.js owns the facts and the paint
   (llmLocalRows, llmRowHTML, llmEmbRun); this file only maps them. */

const MEMCARD_STARTING = 'Starting…';

/**
 * The card's state from what the pane knows about one embedding model.
 * f: {downloaded, pulling, picked (memory search is set to it), enabled
 * (local memory search on), running, health (its server's word), busy (a
 * step for this model is running), error (that step's failure, a sentence),
 * engine (the engine failure: {why, retryable}), chatUp (the local chat
 * server is up)}. Returns null for nothing to say, else {key, word, tone,
 * spin, line, act, label, selected}.
 */
function memCardState(f) {
  const s = f || {};
  if (s.pulling) return null;   // the Downloading pill and the banner's bar say it
  if (s.busy) {
    return {key:'starting', word:MEMCARD_STARTING, tone:'blue', spin:true, selected:!!s.picked,
      line:'Starting the memory model. This takes a few seconds.', act:null, label:null};
  }
  const engine = s.engine && typeof s.engine.why === 'string' ? s.engine : null;
  const engineCard = () => ({key:'engine', word:'Engine not ready', tone:'red', spin:false, selected:!!s.picked,
    line:engine.why, act: engine.retryable === false ? null : 'engf:retry', label: engine.retryable === false ? null : 'Download again'});
  const health = String(s.health || '').toLowerCase();
  const runs = !!s.picked && !!s.downloaded && !!s.enabled && !!s.running && health === 'ok';
  // A server that answers since a failed click wins over that failure.
  if (s.error && !runs) {
    if (engine) return engineCard();
    return {key:'failed', word:'Failed', tone:'red', spin:false, selected:!!s.picked,
      line:String(s.error), act:'llm:embRetry', label:'Retry'};
  }
  if (!s.picked) return null;
  if (!s.downloaded) {
    return {key:'missing', word:'Not downloaded', tone:'amber', spin:false, selected:true,
      line:'Memory search is set to this model, but it is not downloaded yet.', act:null, label:null};
  }
  if (!s.enabled) {
    return {key:'off', word:'Off', tone:'line', spin:false, selected:true,
      line:'Local memory search is off, so the agent searches memory by keyword.', act:null, label:null};
  }
  if (runs) {
    return {key:'running', word:'Running', tone:'green', spin:false, selected:true,
      line:'Memory search uses this model.', act:null, label:null};
  }
  if (s.running && (!health || /loading|starting/.test(health))) {
    return {key:'starting', word:MEMCARD_STARTING, tone:'blue', spin:true, selected:true,
      line:'Loading the memory model.', act:null, label:null};
  }
  if (engine) return engineCard();
  if (s.running) {
    return {key:'stalled', word:'Not answering', tone:'amber', spin:false, selected:true,
      line:'Its server is up but does not answer yet. Check again in a moment.', act:null, label:null};
  }
  return {key:'stopped', word:'Not running', tone:'amber', spin:false, selected:true,
    line: s.chatUp ? 'Its server is not running. Start it to search memory by meaning.'
      : 'It starts with the local model server. Start it to search memory by meaning now.',
    act:null, label:null};
}

/** The reason a step failed, in plain words: what the agent said, without the CLI's prefix. */
function memCardError(res, fallback) {
  const raw = res && (res.error || (res.stderr && String(res.stderr).trim().split('\n').pop()));
  const why = String(raw || '').replace(/^(error:\s*)/i, '').trim();
  return 'Couldn’t start the memory model' + (why ? ': ' + why : fallback ? ': ' + fallback : '.');
}

if (typeof module !== 'undefined') module.exports = {MEMCARD_STARTING, memCardState, memCardError};
