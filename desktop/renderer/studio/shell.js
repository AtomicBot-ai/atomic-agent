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
   openInStudioHTML at its Studio hooks. Shapes: studio/CONTRACT.md.

   Shared with the pages:
     STUDIO.mediaUrl(path)        a file: URL for <video src> (CSP media-src file:)
     STUDIO.sendToChat(target)    target: a path or {path, name?}; the chat on screen
                                  (an empty new one when none) gets it: a picture as an
                                  attachment, anything else as its path in the message box
     STUDIO.openSettings(section) Settings › Models on the cloud providers, so an
                                  OpenRouter key can be added ('openrouter' starts that setup)
   The pure helpers (fileUrl, mediaKindOf, dataUrlToBytes, draftWithPath) are
   exported under Node for test/studio-shell.test.mjs. */
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

  const W = typeof window !== 'undefined' ? window : globalThis;
  const br = () => (W.atomic && W.atomic.studio) || null;
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

  /** 'video' | 'images' | null: the page a file opens in. */
  function mediaKindOf(path) {
    const p = String(path || '');
    return VIDEO_EXT.test(p) ? 'video' : IMAGE_EXT.test(p) ? 'images' : null;
  }

  /** An absolute path as a file: URL, each segment percent-encoded ('' for anything else). */
  function fileUrl(path) {
    const p = String(path == null ? '' : path);
    if (!p || /[\0\r\n]/.test(p)) return '';
    let drive = '', rest;
    if (/^[A-Za-z]:[\\/]/.test(p)) { drive = '/' + p.slice(0, 2); rest = p.slice(2).replace(/\\/g, '/'); }
    else if (p[0] === '/' && p[1] !== '/') rest = p;
    else return '';   // relative, ~, a network share (//host, \\host), a URL
    return 'file://' + drive + rest.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  }

  /** A data: URL's bytes and type (fetch() of a data: URL is blocked by the window's connect-src 'none'). */
  function dataUrlToBytes(url) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url || ''));
    if (!m) return null;
    const type = m[1] || 'application/octet-stream';
    if (!m[2]) return {type, bytes: new TextEncoder().encode(decodeURIComponent(m[3]))};
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return {type, bytes};
  }

  /** The message box with a path added at the end, once. */
  function draftWithPath(draft, path) {
    const d = String(draft || '');
    if (!path || d.includes(path)) return d;
    return (d.trim() ? d.replace(/\s+$/, '') + ' ' : '') + path + ' ';
  }

  /** The picture as a data: URL: Studio's own preview for its files, the chat's reader for any other (home, agent, temp folders). */
  async function pictureDataUrl(path) {
    const s = br();
    if (s && s.preview && STUDIO.isStudioFile(path, 'image')) {
      const r = await Promise.resolve(s.preview(path)).catch(() => null);
      const d = r && r.ok ? r.data : null;
      if (d && d.ok && typeof d.dataUrl === 'string') return d.dataUrl;
    }
    const a = W.atomic;
    if (a && a.imageDataUrl) {
      const r = await Promise.resolve(a.imageDataUrl(path)).catch(() => null);
      if (r && r.ok && typeof r.dataUrl === 'string') return r.dataUrl;
    }
    return null;
  }
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

    /** Opens a picture or a clip in its page ("Open in Studio" under a reply): from the
        gallery when Studio made it, otherwise on its own, as "From chat". */
    openFile(path) {
      const kind = mediaKindOf(path) || 'images';
      if (!pages[kind]) return;
      STUDIO.open(kind);
      safe(pages[kind].focusFile, path);
    },

    /** True for a file inside Studio's output folder for that kind ('image' | 'video'). */
    isStudioFile(path, kind) {
      return isUnder(path, dirs[kind || (VIDEO_EXT.test(String(path)) ? 'video' : 'image')]);
    },

    /** A URL <video> can play the file from: main's, when the bridge has one, else file:. */
    mediaUrl(path) {
      const s = br();
      if (s && typeof s.mediaUrl === 'function') {
        const u = safe(s.mediaUrl, path);
        if (typeof u === 'string' && u) return u;
      }
      return fileUrl(path);
    },

    /** Hands a file to the chat on screen: a picture goes in as an attachment, a clip
        (the agent cannot watch one) as its path in the message box. Resolves true when it landed. */
    async sendToChat(target) {
      const path = typeof target === 'string' ? target : target && typeof target.path === 'string' ? target.path : '';
      if (!path) return false;
      const name = (target && typeof target === 'object' && target.name) || path.split(/[\\/]/).pop() || 'file';
      if (typeof act === 'function') act('room:chat');
      if (mediaKindOf(path) === 'images' && typeof attAdd === 'function') {
        const url = await pictureDataUrl(path);
        const got = url ? dataUrlToBytes(url) : null;
        if (got) {
          let file = null;
          try { file = new File([got.bytes], name, {type: got.type}); } catch (e) { file = null; }
          if (file) { attAdd([{file}], 'studio'); return true; }
        }
      }
      if (typeof S === 'undefined') return false;
      S.draft = draftWithPath(S.draft, path);
      if (typeof FOCUS !== 'undefined') FOCUS.entry = true;
      if (typeof render === 'function') render();
      return true;
    },

    /** Settings › Models on the cloud providers. 'openrouter' opens OpenRouter's setup
        when there is no OpenRouter provider yet (Studio's "Add a key"). */
    openSettings(section) {
      if (typeof act !== 'function') return;
      act('settings:llm');
      let known = false;
      try { known = typeof llmCloudProviders === 'function' && llmCloudProviders().some((p) => p && (p.kind === 'openrouter' || p.id === 'openrouter')); } catch (e) { known = false; }
      act(section === 'openrouter' && !known ? 'llm:preset:openrouter' : 'llm:mode:cloud');
    },

    /** A data: URL as {type, bytes}; null when it is not one. */
    dataUrlToBytes,

    /** Re-read the output folders (after Settings changes one). */
    refreshDirs() {
      const s = br();
      if (!s || !s.outputDir) return;
      for (const k of ['image', 'video']) {
        Promise.resolve(s.outputDir(k)).then((r) => { if (r && r.ok && r.data) dirs[k] = r.data.path || null; }, () => undefined);
      }
    },

    /** The chat's "Open in Studio" button under a reply's pictures and clips: the first one
        Studio made, else the first one (an agent tool saves into the working folder). */
    openInStudioHTML(paths) {
      const media = (paths || []).filter((p) => { const k = mediaKindOf(p); return k && pages[k]; });
      const hit = media.find((p) => STUDIO.isStudioFile(p)) || media[0];
      if (!hit) return '';
      return '<div class="replyfiles-studio"><button class="btn btn-s sm" data-act="studio:file:' + esc(hit) + '">'
        + icon('open') + 'Open in Studio</button></div>';
    },

    _pure: {fileUrl, mediaKindOf, dataUrlToBytes, draftWithPath},
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = STUDIO;
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
