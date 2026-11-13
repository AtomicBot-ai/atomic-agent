/* ATO-1148: a project's own cloud model, the window's half.

   A project is a chat's working folder. Picking a cloud model in the
   composer's switcher remembers it for that folder (main/project-model.ts
   keeps the file); every turn of a chat in that folder, new chats
   included, carries the pick (BR.chat's turnModel) and the agent runs that
   turn on it without switching its active model. So no restart, no "wait
   until the other chats finish", and the other folders keep their model.

   Only while the window's route is a single cloud model: the Local / Cloud
   / Fusion switch stays one for the whole agent, and a local model is one
   per agent, which its rows say. Shared by the renderer and Node checks;
   no DOM, no IPC of its own (the bridge is handed in). */

const PROJECT_LOCAL_NOTE = 'Local model is shared by all projects';

/* The key a folder is stored under; main/project-model.ts folderKey. */
function projectFolderKey(dir, win) {
  const raw = String(dir || '').trim();
  if (!raw) return '';
  if (win) {
    const w = raw.replace(/\//g, '\\').replace(/\\+$/, '');
    return (/^[a-zA-Z]:$/.test(w) ? w + '\\' : w).toLowerCase();
  }
  return raw.replace(/\/+$/, '') || '/';
}

/* A server on this machine or the local network; main/local-server-url.ts, kept alike. */
function projectLocalUrl(url) {
  if (!url) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  const v4 = host.split('.');
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const a = Number(v4[0]), b = Number(v4[1]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes('.')) return true;
  return ['.local', '.lan', '.internal', '.home.arpa'].some((s) => host.endsWith(s));
}

/* A provider entry a project's model can run on: configured and not on this machine. */
function projectCloudEntry(entry) {
  return !!entry && entry.kind !== 'llama-server' && !projectLocalUrl(entry.baseUrl || entry.url);
}

/* The folder's pick when it applies now: the route is a single cloud
   model and the pick's provider is still a configured cloud one. */
function projectPickApplies(pick, providers, backend) {
  if (!pick || backend !== 'cloud') return null;
  const entry = (providers || []).find((p) => p && p.id === pick.providerId);
  return projectCloudEntry(entry) ? {providerId: pick.providerId, model: pick.model} : null;
}

function createProjectModels(opts) {
  const win = !!(opts && opts.win);
  const st = {folders: {}, chats: {}, remote: false, loaded: false, note: PROJECT_LOCAL_NOTE};
  const key = (dir) => projectFolderKey(dir, win);
  return {
    state: st,
    localNote: () => st.note || PROJECT_LOCAL_NOTE,
    /* The whole map, once at start and after each write (it is small). */
    async load(api) {
      if (!api || !api.projectModels) return false;
      const res = await Promise.resolve().then(() => api.projectModels()).catch(() => null);
      if (!res || !res.ok) return false;
      st.folders = res.folders && typeof res.folders === 'object' ? res.folders : {};
      st.remote = res.remote === true;
      if (typeof res.localNote === 'string' && res.localNote) st.note = res.localNote;
      st.loaded = true;
      return true;
    },
    /* A chat's own folder, as the agent stored it (openSession) or moved it (chooseWorkspace). */
    noteChatFolder(sessionId, dir) {
      if (sessionId && typeof dir === 'string' && dir) st.chats[sessionId] = dir;
    },
    /* The folder a chat works in: its own when known, else the window's (a new chat opens there). */
    folderOf(sessionId, windowFolder) {
      return (sessionId && st.chats[sessionId]) || windowFolder || '';
    },
    pickFor(folder) {
      const k = key(folder);
      return (k && st.folders[k]) || null;
    },
    /* What a turn of a chat in `folder` sends, or null for the agent's own model. */
    turnModel(folder, providers, backend) {
      if (st.remote) return null;
      return projectPickApplies(this.pickFor(folder), providers, backend);
    },
    /* Remember (or, with null, forget) the folder's model. */
    async set(api, folder, pick) {
      if (!api || !api.setProjectModel) return {ok: false, unsupported: true};
      if (!folder) return {ok: false, error: 'This chat has no folder yet'};
      const res = await Promise.resolve().then(() => api.setProjectModel(folder, pick)).catch((e) => ({ok: false, error: String(e)}));
      if (res && res.ok && res.folders && typeof res.folders === 'object') st.folders = res.folders;
      return res || {ok: false, error: 'no answer'};
    },
  };
}

const ProjectModels = createProjectModels({win: typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')});
if (typeof window !== 'undefined') window.ProjectModels = ProjectModels;
if (typeof module !== 'undefined') module.exports = {PROJECT_LOCAL_NOTE, projectFolderKey, projectLocalUrl, projectCloudEntry, projectPickApplies, createProjectModels};
