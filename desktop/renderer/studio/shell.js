/* Studio shell: the "Studio" group in the sidebar (Images, Video), the Studio
   room next to the chats, and the one subscription to BR.studio's job events.

   A page plugs in with
     STUDIO.register(kind, {title, icon, render(rootEl), onEvent(job), onShow(), onHide(),
                            act?(verb), onKey?(e), focusFile?(path)})
   `kind` is 'images' or 'video'. render() runs once, the first time the page
   is opened: its root element is kept while the person is elsewhere and put
   back as it was, so a half-written prompt or a running job's card survives a
   trip to a chat. onEvent gets every StudioJob change of its kind (image jobs
   go to 'images', video jobs to 'video'), shown or not, so a job that ends
   while the page is away is still taken in. act(verb) gets a click on
   `data-act="studio:<kind>:<verb>"` (the window's one click delegate, act()).

   Loaded before renderer.js and declares one global, window.STUDIO; it reads
   renderer.js globals (S, act, render, renderSidebar, ic, esc, P) only when a
   function runs. renderer.js calls sidebarHTML / mount / leave / act / key /
   openInStudioHTML at its Studio hooks. Shapes: studio/CONTRACT.md. */
(function () {
  const ORDER = ['images', 'video'];
  const PAGE_OF = {image: 'images', video: 'video'};
  /* Icons renderer.js does not draw (16px grid, its stroke). */
  const OWN_ICONS = {
    video: '<rect x="2" y="4" width="8.5" height="8" rx="2"/><path d="m10.5 7 3.5-2v6l-3.5-2"/>',
  };
  const pages = {};
  const roots = {};
  const running = {images: new Set(), video: new Set()};
  const dirs = {image: null, video: null};
  let cur = 'images';
  let shown = null;

  const br = () => (typeof window !== 'undefined' && window.atomic && window.atomic.studio) || null;
  const safe = (fn, ...args) => { try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (e) { console.error('[studio]', e); return undefined; } };

  function icon(name) {
    if (typeof name === 'string' && name.startsWith('<svg')) return name;
    if (typeof P !== 'undefined' && P[name]) return ic(name);
    const body = OWN_ICONS[name] || '';
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function repaintSidebar() { if (typeof renderSidebar === 'function') safe(renderSidebar); }

  function hide(kind) { if (pages[kind]) safe(pages[kind].onHide); }

  function track(job) {
    const kind = PAGE_OF[job && job.kind];
    if (!kind || !job.id) return;
    const set = running[kind];
    const had = set.has(job.id);
    const live = job.state === 'queued' || job.state === 'generating';
    if (live) set.add(job.id); else set.delete(job.id);
    if (had !== live) repaintSidebar();
  }

  function forward(job) {
    if (!job || typeof job !== 'object') return;
    track(job);
    const page = pages[PAGE_OF[job.kind]];
    if (page) safe(page.onEvent, job);
  }

  function isUnder(path, dir) {
    if (!path || !dir) return false;
    const p = String(path), d = String(dir).replace(/[\\/]+$/, '');
    return p.length > d.length + 1 && p.startsWith(d) && (p[d.length] === '/' || p[d.length] === '\\');
  }

  const STUDIO = {
    pages,

    register(kind, page) {
      if (!kind || !page) return;
      pages[kind] = page;
      repaintSidebar();
    },

    /** Opens a page in the Studio room. */
    open(kind) {
      if (!pages[kind]) return;
      cur = kind;
      if (typeof act === 'function') act('room:studio');
    },

    /** The page on screen, or null when the Studio room is not. */
    current() {
      return typeof S !== 'undefined' && S.room === 'studio' ? cur : null;
    },

    title() { return pages[cur] ? pages[cur].title : 'Studio'; },

    /* ---------- renderer.js hooks ---------- */

    /** The sidebar's Studio group, between New chat and Chats. */
    sidebarHTML(room) {
      const kinds = ORDER.filter((k) => pages[k]).concat(Object.keys(pages).filter((k) => !ORDER.includes(k)));
      if (!kinds.length) return '';
      return '<div class="sb-studio" role="group" aria-label="Studio">'
        + '<div class="sb-list-head micro"><span>Studio</span></div>'
        + kinds.map((k) => {
          const p = pages[k];
          const on = room === 'studio' && cur === k;
          const busy = running[k] && running[k].size > 0;
          return '<button class="sb-new sb-studio-row' + (on ? ' on' : '') + '" data-act="studio:open:' + esc(k) + '"'
            + (on ? ' aria-current="page"' : '')
            + ' title="' + esc(p.title + (busy ? ' · working' : '')) + '" aria-label="' + esc(p.title) + '">'
            + '<span class="sb-new-ic">' + icon(p.icon) + '</span><span class="sb-new-lb">' + esc(p.title) + '</span>'
            + (busy ? '<span class="sb-studio-dot" aria-label="working"></span>' : '')
            + '</button>';
        }).join('')
        + '</div>';
    },

    /** Puts the current page into #content; a page already there is left alone. */
    mount(c) {
      const kind = pages[cur] ? cur : ORDER.find((k) => pages[k]);
      if (!kind) { shown = null; c.innerHTML = '<div class="studio-missing">Studio is not available in this build.</div>'; return; }
      cur = kind;
      let root = roots[kind];
      if (root && shown === kind && root.parentNode === c && c.childElementCount === 1) return;
      if (shown && shown !== kind) hide(shown);
      c.textContent = '';
      if (!root) {
        root = document.createElement('div');
        root.className = 'studio studio-' + kind;
        root.dataset.studio = kind;
        roots[kind] = root;
        c.appendChild(root);
        safe(pages[kind].render, root);
      } else {
        c.appendChild(root);
      }
      shown = kind;
      safe(pages[kind].onShow);
    },

    /** The room changed away from Studio. */
    leave() {
      if (!shown) return;
      const k = shown;
      shown = null;
      hide(k);
    },

    /** `studio:<verb>` from act(). */
    act(v) {
      const s = String(v || '');
      const i = s.indexOf(':');
      const head = i < 0 ? s : s.slice(0, i), rest = i < 0 ? '' : s.slice(i + 1);
      if (head === 'open') { STUDIO.open(rest || cur); return; }
      if (head === 'file') { STUDIO.openFile(rest); return; }
      const page = pages[head];
      if (page) safe(page.act, rest);
    },

    /** Keys while the Studio room is on screen. True when consumed. ⌘↩ never reaches the chat's Send here. */
    key(e) {
      const page = pages[cur];
      const handled = page ? safe(page.onKey, e) === true : false;
      if (handled) return true;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return true; }
      return false;
    },

    /** Opens the library on a file Studio made (a reply's picture, "Open in Studio"). */
    openFile(path) {
      const kind = /\.(mp4|webm|mov|m4v)$/i.test(String(path)) ? 'video' : 'images';
      if (!pages[kind]) return;
      STUDIO.open(kind);
      safe(pages[kind].focusFile, path);
    },

    /** True for a file inside Studio's output folder for that kind. */
    isStudioFile(path, kind) {
      return isUnder(path, dirs[kind || (/\.(mp4|webm|mov|m4v)$/i.test(String(path)) ? 'video' : 'image')]);
    },

    /** Re-read the output folders (after Settings changes one). */
    refreshDirs() {
      const s = br();
      if (!s || !s.outputDir) return;
      for (const k of ['image', 'video']) {
        Promise.resolve(s.outputDir(k)).then((r) => { if (r && r.ok && r.data) dirs[k] = r.data.path || null; }, () => undefined);
      }
    },

    /** The chat's "Open in Studio" button under a reply's pictures that Studio made. */
    openInStudioHTML(paths) {
      const hit = (paths || []).find((p) => STUDIO.isStudioFile(p));
      if (!hit || !pages[/\.(mp4|webm|mov|m4v)$/i.test(hit) ? 'video' : 'images']) return '';
      return '<div class="replyfiles-studio"><button class="btn btn-s sm" data-act="studio:file:' + esc(hit) + '">'
        + icon('open') + 'Open in Studio</button></div>';
    },
  };

  if (typeof window !== 'undefined') {
    window.STUDIO = STUDIO;
    const s = br();
    if (s) {
      if (s.onJob) s.onJob(forward);
      if (s.activeJobs) Promise.resolve(s.activeJobs()).then((r) => { if (r && r.ok && Array.isArray(r.data)) r.data.forEach(forward); }, () => undefined);
      STUDIO.refreshDirs();
    }
  }
})();
