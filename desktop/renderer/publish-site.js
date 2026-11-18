/* ---------------- ATO-594: "Publish…" on a page the agent made ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/publish-site.test.mjs).

   A reply's .html file is drawn as a page (chat-artifact.js). Its bar gets
   a Publish… button: a short confirm says what happens, then the chat gets
   one message asking the agent to run the `publish-site` starter skill
   (starter-skills/publish-site: GitHub Pages by default, Cloudflare Pages
   or Netlify, through the person's own CLI sign-in) on the page's folder.
   Nothing goes online from here: the skill runs its preflight, says what
   would be uploaded and where, and waits for an explicit yes, and every
   command still shows the approval prompt. Like Claude's artifact
   "Publish" and Lovable / Bolt "Deploy", minus a host of ours. */

const PUBSITE = {pending: null};

/** The folder a page lives in (the site to publish); '' for no usable path. */
function publishSiteFolder(path) {
  const s = String(path || '');
  if (!/\.html?$/i.test(s)) return '';
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '';
}

/** The words sent to the agent for one page. */
function publishSiteRequest(path) {
  const folder = publishSiteFolder(path);
  return 'Publish the static site in ' + JSON.stringify(folder) + ' (its page ' + JSON.stringify(String(path)) + ').'
    + ' Run the preflight check first, then tell me what would be uploaded, where it would go and the address it would get,'
    + ' and wait for my yes before publishing anything.';
}

/** The full message: the starter skill, loaded first (workspace-skills.js), then the request. */
function publishSiteMessage(path) {
  const req = publishSiteRequest(path);
  return typeof workspaceSkillMessage === 'function'
    ? workspaceSkillMessage('publish-site', req)
    : 'Use the "publish-site" skill. Load its instructions with skill.view({"name":"publish-site"}) before proceeding.\n\n' + req;
}

/** The page bar's button; '' for a path that is not a page in a folder. */
function publishSiteButtonHTML(path, escape) {
  if (!publishSiteFolder(path)) return '';
  const e = typeof escape === 'function' ? escape : (s) => String(s);
  return '<button class="filechip chat-art-pub" data-act="pubsite:' + e(path) + '" title="Ask the agent to put this site online on your own GitHub, Cloudflare or Netlify account. It asks before anything goes up.">'
    + (typeof ic === 'function' ? ic('upload') : '') + '<span>Publish…</span></button>';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

/** pubsite:<page path> opens the confirm; pubsitego: sends the request. */
function publishSiteAct(k, v) {
  if (k === 'pubsite') {
    const folder = publishSiteFolder(v);
    if (!folder) return;
    PUBSITE.pending = String(v);
    S.alert = {title: 'Publish this site?', ok: 'Ask the agent', act: 'pubsitego:',
      msg: 'The agent checks ' + folder + ', says what would go online and where, and waits for your yes. A published site is public.'};
    render();
    return;
  }
  if (k === 'pubsitego') {
    const path = PUBSITE.pending;
    PUBSITE.pending = null;
    S.alert = null;
    render();
    if (path) submit(publishSiteMessage(path), {plain: true});
  }
}

if (typeof module !== 'undefined') module.exports = {publishSiteFolder, publishSiteRequest, publishSiteMessage, publishSiteButtonHTML};
