/* ---------------- config writes through PATCH /api/config (agent 0.6.6) ----------------
   Loaded before renderer.js; declares only.

   On 0.6.6 the route deep-merges into config.json AND drops the running
   agent's cached config, so the change is live from the next turn with no
   restart. A CLI write (`atag config set`, the whole-file write) changes
   only the file, and the running agent keeps what it booted with.

   main/agent-live.ts refuses the patch on an older agent (whose PATCH was a
   shallow merge that dropped whole blocks) with `unsupported: true`; the
   caller's own CLI write runs instead, exactly as before.

   Answers {ok, live, error?}: `live` is true when the running agent already
   has the change, false when only the file does (restart to apply). */
async function configPatchOr(patch, fallback) {
  if (BR && BR.configPatch) {
    const res = await BR.configPatch(patch);
    if (res && res.ok) return {ok:true, live:true};
    if (!(res && res.unsupported)) return {ok:false, live:false, error:(res && res.error) || 'config write failed'};
  }
  const res = await fallback();
  if (!res || res.ok === false) return {ok:false, live:false, error:(res && res.error) || 'config write failed'};
  return {ok:true, live:false};
}
