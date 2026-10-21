// Studio shell, renderer side: the file: URL a clip plays from, handing a
// picture or a clip to the chat (sendToChat with stubbed renderer globals),
// Settings for an OpenRouter key, "Open in Studio" under a reply, and the
// Video page opening a clip from a chat. shell.js and video.js run in a vm
// context; nothing touches Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SHELL = readFileSync(new URL('../renderer/studio/shell.js', import.meta.url), 'utf8');
const VIDEO = readFileSync(new URL('../renderer/studio/video.js', import.meta.url), 'utf8');

class FakeFile {
  constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = (opts && opts.type) || ''; }
}

function load(extra = {}) {
  const calls = { act: [], attAdd: [], render: 0 };
  const ctx = {
    console, Promise, atob, TextEncoder, File: FakeFile,
    module: { exports: {} },
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    act: (a) => { calls.act.push(a); },
    attAdd: (list, method) => { calls.attAdd.push({ list, method }); },
    render: () => { calls.render++; },
    S: { draft: '', room: 'studio' },
    FOCUS: { entry: false },
    ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SHELL, ctx, { filename: 'shell.js' });
  return { ctx, STUDIO: ctx.module.exports, calls };
}

test('mediaUrl: an absolute path becomes a file: URL with every segment encoded', () => {
  const { STUDIO } = load();
  assert.equal(STUDIO.mediaUrl('/Users/nadia/My Clips/a#1?.mp4'), 'file:///Users/nadia/My%20Clips/a%231%3F.mp4');
  assert.equal(STUDIO.mediaUrl('/tmp/100%.webm'), 'file:///tmp/100%25.webm');
  assert.equal(STUDIO.mediaUrl('/Users/n/Видео.mp4'), 'file:///Users/n/%D0%92%D0%B8%D0%B4%D0%B5%D0%BE.mp4');
  assert.equal(STUDIO.mediaUrl('C:\\Users\\N N\\clip.mp4'), 'file:///C:/Users/N%20N/clip.mp4');
  // A quote cannot end the attribute it is written into.
  assert.ok(!/["<>]/.test(STUDIO.mediaUrl('/a/"><script>.mp4')));
});

test('mediaUrl: anything but an absolute local path gives nothing', () => {
  const { STUDIO } = load();
  for (const p of ['', 'clip.mp4', 'out/clip.mp4', '~/clip.mp4', '//host/share/clip.mp4', '\\\\host\\share\\clip.mp4',
    'file:///x.mp4', 'https://x/y.mp4', '/a\nb.mp4', '/a\0.mp4', null, undefined]) {
    assert.equal(STUDIO.mediaUrl(p), '', String(p));
  }
});

test('mediaUrl: the bridge\'s own URL wins when it has one', () => {
  const { STUDIO } = load({ atomic: { studio: { mediaUrl: (p) => 'atomic-media://' + p } } });
  assert.equal(STUDIO.mediaUrl('/a/b.mp4'), 'atomic-media:///a/b.mp4');
});

test('sendToChat: a picture from a chat is read through the chat reader and attached', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const asked = [];
  const { STUDIO, calls, ctx } = load({ atomic: { imageDataUrl: async (p) => { asked.push(p); return { ok: true, dataUrl: 'data:image/png;base64,' + png }; } } });
  const ok = await STUDIO.sendToChat('/Users/n/work/cat.png');
  assert.equal(ok, true);
  assert.deepEqual(calls.act, ['room:chat']);
  assert.deepEqual(asked, ['/Users/n/work/cat.png']);
  assert.equal(calls.attAdd.length, 1);
  const { list, method } = calls.attAdd[0];
  assert.equal(method, 'studio');
  const file = list[0].file;
  assert.equal(file.name, 'cat.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Array.from(file.parts[0]), [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal(ctx.S.draft, '');
});

test('sendToChat: a Studio picture is read through Studio\'s preview', async () => {
  const studio = {
    outputDir: (k) => Promise.resolve({ ok: true, data: { path: k === 'image' ? '/S/images' : '/S/videos' } }),
    preview: async () => ({ ok: true, data: { ok: true, dataUrl: 'data:image/webp;base64,AAEC' } }),
  };
  const { STUDIO, calls } = load({ atomic: { studio, imageDataUrl: async () => { throw new Error('not this one'); } } });
  await new Promise((r) => setImmediate(r));   // refreshDirs
  assert.equal(await STUDIO.sendToChat({ path: '/S/images/a-01.webp', name: 'a.webp' }), true);
  const file = calls.attAdd[0].list[0].file;
  assert.equal(file.name, 'a.webp');
  assert.equal(file.type, 'image/webp');
  assert.deepEqual(Array.from(file.parts[0]), [0, 1, 2]);
});

test('sendToChat: a clip goes into the message box as its path, once', async () => {
  const { STUDIO, calls, ctx } = load();
  ctx.S.draft = 'look at this ';
  assert.equal(await STUDIO.sendToChat({ path: '/Users/n/work/clip one.mp4', kind: 'video' }), true);
  assert.deepEqual(calls.act, ['room:chat']);
  assert.equal(calls.attAdd.length, 0);
  assert.equal(ctx.S.draft, 'look at this /Users/n/work/clip one.mp4 ');
  assert.equal(ctx.FOCUS.entry, true);
  assert.equal(calls.render, 1);
  await STUDIO.sendToChat('/Users/n/work/clip one.mp4');
  assert.equal(ctx.S.draft, 'look at this /Users/n/work/clip one.mp4 ');
});

test('sendToChat: a picture that cannot be read falls back to its path; nothing at all for no path', async () => {
  const { STUDIO, calls, ctx } = load({ atomic: { imageDataUrl: async () => ({ ok: false, reason: 'outside' }) } });
  assert.equal(await STUDIO.sendToChat('/etc/x.png'), true);
  assert.equal(calls.attAdd.length, 0);
  assert.equal(ctx.S.draft, '/etc/x.png ');
  assert.equal(await STUDIO.sendToChat(''), false);
  assert.equal(await STUDIO.sendToChat({}), false);
});

test('openSettings: Models on Cloud providers; OpenRouter\'s setup only when there is none', () => {
  const a = load();
  a.STUDIO.openSettings('openrouter');
  assert.deepEqual(a.calls.act, ['settings:llm', 'llm:preset:openrouter']);
  const b = load({ llmCloudProviders: () => [{ id: 'openrouter', kind: 'openrouter' }] });
  b.STUDIO.openSettings('openrouter');
  assert.deepEqual(b.calls.act, ['settings:llm', 'llm:mode:cloud']);
  const c = load();
  c.STUDIO.openSettings('providers');
  assert.deepEqual(c.calls.act, ['settings:llm', 'llm:mode:cloud']);
});

test('dataUrlToBytes: base64 and plain data: URLs; null for anything else', () => {
  const { STUDIO } = load();
  assert.deepEqual(Array.from(STUDIO.dataUrlToBytes('data:image/png;base64,AAEC').bytes), [0, 1, 2]);
  assert.equal(STUDIO.dataUrlToBytes('data:,a%20b').type, 'application/octet-stream');
  assert.equal(new TextDecoder().decode(STUDIO.dataUrlToBytes('data:,a%20b').bytes), 'a b');
  assert.equal(STUDIO.dataUrlToBytes('https://x/y.png'), null);
});

test('Open in Studio: under any reply picture or clip, a Studio file first; opens the right page', () => {
  const focused = [];
  const { STUDIO, calls } = load();
  STUDIO.register('images', { title: 'Images', focusFile: (p) => focused.push(['images', p]) });
  STUDIO.register('video', { title: 'Video', focusFile: (p) => focused.push(['video', p]) });
  assert.equal(STUDIO.openInStudioHTML(['/w/notes.txt']), '');
  const html = STUDIO.openInStudioHTML(['/w/notes.txt', '/w/clip.mp4', '/w/cat.png']);
  assert.match(html, /data-act="studio:file:\/w\/clip\.mp4"/);
  assert.match(html, /Open in Studio/);
  STUDIO.act('file:/w/clip.mp4');
  STUDIO.act('file:/w/cat.png');
  assert.deepEqual(focused, [['video', '/w/clip.mp4'], ['images', '/w/cat.png']]);
  assert.deepEqual(calls.act, ['room:studio', 'room:studio']);
});

test('Video page: a clip from a chat opens on its own, playing from its file: URL', async () => {
  const { ctx, STUDIO } = load();
  vm.runInContext(VIDEO, ctx, { filename: 'video.js' });
  const page = ctx.StudioVideo.createPage();
  page.focusFile('/Users/n/work/my clip.mp4');
  await new Promise((r) => setImmediate(r));
  const st = page._state;
  assert.equal(st.result.fromChat, true);
  assert.equal(st.result.path, '/Users/n/work/my clip.mp4');
  assert.equal(st.videoSrc, STUDIO.mediaUrl('/Users/n/work/my clip.mp4'));
  assert.equal(st.playError, false);
});
