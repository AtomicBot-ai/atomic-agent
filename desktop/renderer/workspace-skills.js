/* Shared by the renderer and Node checks; no filesystem or permission policy. */
function workspaceSkillCommands(rows, builtins) {
  const reserved = new Set(builtins.flatMap(row => [row[0], ...(row[3] || [])]));
  const seen = new Set();
  return (rows || []).filter(row => row.enabled && /^[\w.-]{1,64}$/.test(row.name)
    && !reserved.has(row.name) && !seen.has(row.name) && seen.add(row.name))
    .map(row => [row.name, row.description, 'skill']);
}
function workspaceSkillMessage(name, input) {
  return 'Use the ' + JSON.stringify(name) + ' skill. Load its instructions with skill.view('
    + JSON.stringify({name}) + ') before proceeding.' + (input ? '\n\n' + input : '');
}
function createSkillCatalogLoader(read) {
  let serial = 0, pending = null;
  return {
    load(key, sessionId) {
      if (pending && pending.key === key) return pending.promise;
      const version = ++serial;
      const promise = Promise.resolve().then(() => read(sessionId))
        .catch(error => ({ok:false, error:String(error)}))
        .then(result => ({current: version === serial, result}))
        .finally(() => { if (pending && pending.version === version) pending = null; });
      pending = {key, version, promise};
      return promise;
    },
  };
}
if (typeof module !== 'undefined') module.exports = {workspaceSkillCommands, workspaceSkillMessage, createSkillCatalogLoader};
