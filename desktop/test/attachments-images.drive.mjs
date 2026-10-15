// ATO-403 attachments and ATO-408 reply pictures, driven end to end. No model.
//
//   cd desktop && npm run build && (cd .. && npm run build)
//   node test/attachments-images.drive.mjs [--port 9433] [--keep] [--shots <dir>]
//
// 1. picker: "+" → Images / Files (the open dialog replaced by `--fake-pick`,
//    a test-only flag in main/attachments-ipc.ts): an image chip with its
//    thumbnail, a document chip, and the remove X (its inbox file goes too).
// 2. paste and drop: an image pasted into the box and a file dropped on the
//    window become chips; the drop highlights the composer; a dropped image
//    over 64 MB is refused on its chip and never read.
// 3. history, the reopen path: turns as the agent stores them go through
//    sessionTurnsToLog. The user's message shows its caption and chips, never
//    the raw `[attachments]` block; with ATO-408 in the build the reply shows
//    its picture inline and its text file as a chip, and the picture opens in
//    the viewer, which Escape closes (SKIP lines without ATO-408).
// 4. copy: the user message's Copy button copies the caption only.
// 5. send: the message that goes out is the caption plus an `[attachments]`
//    block in exactly the channel inbox's format (src/channels/attachments/
//    inbox.ts, hint line read from that file), naming files that exist under
//    <state>/inbox/desktop/<day>/; the chips are cleared. The turn itself
//    fails (no model): only what was sent is checked.
//
// Runs on a throwaway state directory under the OS temp dir and refuses to
// start on anything else: ~/.atomic-agent and ~/.atomic-agent-desktop are
// never touched.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

import { launch, REPO_DIR, sleep } from './drive.mjs';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]) || 9433;
const keep = argv.includes('--keep');
const shots = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
const shot = async (name) => { if (shots) await app.screenshot(join(shots, name + '.png')); };

const cli = join(REPO_DIR, 'dist', 'cli', 'index.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'atag-attach-')));
const stateDir = join(root, 'state');
const workspace = join(root, 'ws');
const configFile = join(stateDir, 'config.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  (${why})`); }

// --- never the real profile ----------------------------------------------------
const tmpReal = realpathSync(tmpdir());
for (const real of [join(homedir(), '.atomic-agent'), join(homedir(), '.atomic-agent-desktop')]) {
  if (resolve(stateDir) === resolve(real) || resolve(stateDir).startsWith(resolve(real) + sep)) {
    console.error(`refusing to run: ${stateDir} is real app data`); process.exit(2);
  }
}
if (!resolve(stateDir).startsWith(tmpReal + sep)) { console.error(`refusing to run: ${stateDir} is not under ${tmpReal}`); process.exit(2); }

// --- fixtures --------------------------------------------------------------------
/** A real PNG (w×h, one colour), so the window can decode it and draw a thumbnail. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const now = new Date();
const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const inboxDay = join(stateDir, 'inbox', 'desktop', day);
const inboxFiles = () => (existsSync(inboxDay) ? readdirSync(inboxDay).sort() : []);

const fx = join(root, 'fixtures');
mkdirSync(fx, { recursive: true });
writeFileSync(join(fx, 'red.png'), png(40, 30, [220, 40, 40]));
writeFileSync(join(fx, 'brief.pdf'), PDF);
const pickFile = join(fx, 'pick.json');
writeFileSync(pickFile, JSON.stringify({ images: [join(fx, 'red.png')], files: [join(fx, 'brief.pdf')] }));

// The channel inbox's own hint line, read from its source: the block must match it byte for byte.
const inboxSrc = readFileSync(join(REPO_DIR, 'src', 'channels', 'attachments', 'inbox.ts'), 'utf8');
const HINT = (inboxSrc.match(/const HINT_LINE =\s*"([^"]+)";/) || [])[1];
const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

// --- a configured state dir: past the first-run wizard, an external route (no local gate) ----
mkdirSync(stateDir, { recursive: true });
execFileSync(process.execPath, [cli, 'config', 'get'], { env: { ...process.env, ATOMIC_AGENT_STATE_DIR: stateDir }, stdio: 'ignore' });
const seeded = JSON.parse(readFileSync(configFile, 'utf8'));
seeded.tui = { ...(seeded.tui || {}), onboarding: { ...((seeded.tui || {}).onboarding || {}), skippedAt: new Date().toISOString() } };
seeded.localModels = { ...(seeded.localModels || {}), mode: 'external' };
writeFileSync(configFile, JSON.stringify(seeded, null, 2));

const app = await launch({
  port, stateDir, workspace, verbose: false,
  args: [`--fake-pick=${pickFile}`],
  env: { ATOMIC_AGENT_DESKTOP_STATE_DIR: stateDir },
});
const ev = (expr) => app.eval(expr);
const chips = () => ev(`[...document.querySelectorAll('#attstrip .attchip')].map((c) => ({
  img: c.classList.contains('is-img'), doc: c.classList.contains('is-doc'), err: c.classList.contains('is-err'),
  busy: c.classList.contains('is-busy'), thumb: !!c.querySelector('img.attthumb'),
  name: (c.querySelector('.attname') || {}).textContent || c.getAttribute('title') || '', sub: (c.querySelector('.attsub') || {}).textContent || '' }))`);
const settled = `!document.querySelector('#attstrip .attchip.is-busy')`;
/** A File built in the page from bytes the test holds. */
const fileExpr = (bytes, name, type) => `new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), (c) => c.charCodeAt(0))], ${JSON.stringify(name)}, {type: ${JSON.stringify(type)}})`;

try {
  await app.waitFor(`window.atomic && window.atomic.health().then((r) => r.ok)`, 'agent answers /health', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('#composer .attbtn')`, 'the composer with its + button', { timeout: 30000 });
  check('setup: the build exposes the attachment bridge', (await ev(`window.atomic && typeof window.atomic.attachSave === 'function'`)) === true);

  // ---- 1. picker: + → Images, + → Files, remove ----
  await app.clickSel('#composer .attbtn');
  await app.waitFor(`!document.getElementById('attmenu').hidden`, 'the + menu');
  check('picker: + opens the Images / Files menu', (await ev(`[...document.querySelectorAll('#attmenu .attmenurow')].map((b) => b.textContent.trim()).join(',')`)) === 'Images,Files');
  await app.clickSel('#attmenu [data-att-pick="images"]');
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 1 && ${settled}`, 'the image chip', { timeout: 15000 });
  await app.clickSel('#composer .attbtn');
  await app.clickSel('#attmenu [data-att-pick="files"]');
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 2 && ${settled}`, 'the document chip', { timeout: 15000 });
  let c = await chips();
  check('picker: the image is a 56px thumbnail chip', c[0] && c[0].img && c[0].thumb && !c[0].err, JSON.stringify(c[0]));
  check('picker: the document is an icon + name + size chip', c[1] && c[1].doc && /brief\.pdf$/.test(c[1].name) && / B$/.test(c[1].sub), JSON.stringify(c[1]));
  check('picker: both are saved under <state>/inbox/desktop/<day>/', inboxFiles().some((f) => /^\d{6}-red\.png$/.test(f)) && inboxFiles().some((f) => /^\d{6}-brief\.pdf$/.test(f)), inboxFiles().join(','));
  await shot('1-picked');
  const pdfBefore = inboxFiles().filter((f) => /brief\.pdf$/.test(f));
  await app.clickSel('#attstrip .attchip.is-doc [data-att-remove]');
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 1`, 'one chip left');
  await sleep(400);
  check('picker: X removes the chip and its unsent inbox file', pdfBefore.length === 1 && !inboxFiles().includes(pdfBefore[0]), inboxFiles().join(','));

  // ---- 2. paste, drop, oversized drop ----
  await app.clickSel('#entry');
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(${fileExpr(png(8, 8, [20, 120, 220]), 'image.png', 'image/png')});
    document.getElementById('entry').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); return true; })()`);
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 2 && ${settled}`, 'the pasted chip', { timeout: 15000 });
  c = await chips();
  check('paste: a clipboard image becomes a thumbnail chip', c[1] && c[1].img && c[1].thumb, JSON.stringify(c[1]));
  check('paste: saved as pasted-image.png', inboxFiles().some((f) => /^\d{6}-pasted-image\.png$/.test(f)), inboxFiles().join(','));

  const dropped = await ev(`(() => { const dt = new DataTransfer(); dt.items.add(${fileExpr(Buffer.from('# notes\nhello\n'), 'notes.md', 'text/markdown')});
    const target = document.getElementById('composer');
    target.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true, cancelable: true}));
    const lit = target.classList.contains('att-dragging');
    target.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
    target.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    return {lit, after: document.getElementById('composer').classList.contains('att-dragging')}; })()`);
  check('drop: dragging files over the window highlights the composer, the drop clears it', dropped.lit && !dropped.after, JSON.stringify(dropped));
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 3 && ${settled}`, 'the dropped chip', { timeout: 15000 });
  c = await chips();
  check('drop: a dropped file becomes a document chip', c[2] && c[2].doc && /notes\.md$/.test(c[2].name), JSON.stringify(c[2]));

  const before = inboxFiles().length;
  await ev(`(() => { const f = new File([new Uint8Array(65 * 1024 * 1024)], 'huge.png', {type: 'image/png'});
    window.__attHugeRead = false;
    f.arrayBuffer = () => { window.__attHugeRead = true; return Promise.resolve(new ArrayBuffer(0)); };
    // A DataTransfer hands back its own copies of a File, so the event carries this very File (and its spy) itself.
    const e = new DragEvent('drop', {bubbles: true, cancelable: true});
    Object.defineProperty(e, 'dataTransfer', {value: {types: ['Files'], files: [f]}});
    document.getElementById('composer').dispatchEvent(e); return true; })()`);
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 4`, 'the oversized chip', { timeout: 10000 });
  await sleep(300);
  c = await chips();
  check('drop: an image over 64 MB is an error chip', c[3] && c[3].err && /10 MB/.test(c[3].sub), JSON.stringify(c[3]));
  check('drop: and is never read or saved', (await ev('window.__attHugeRead')) === false && inboxFiles().length === before, `read=${await ev('window.__attHugeRead')} files=${inboxFiles().length - before}`);
  await shot('2-chips');
  await app.clickSel('#attstrip .attchip.is-err [data-att-remove]');
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 3`, 'error chip removed');

  // ---- 3. history: a stored chat, drawn by the reopen path ----
  const hist = join(stateDir, 'inbox', 'desktop', day, '120000-history.png');
  mkdirSync(join(stateDir, 'inbox', 'desktop', day), { recursive: true });
  writeFileSync(hist, png(64, 48, [40, 180, 90]));
  const out = join(stateDir, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'reply.png'), png(120, 80, [200, 160, 30]));
  writeFileSync(join(out, 'reply.txt'), 'the answer\n');
  const caption = 'what is in this picture?';
  const userText = [caption, '', '[attachments]', `- ${hist} (image/png, ${formatBytes(statSync(hist).size)})`, HINT].join('\n');
  const turns = [
    { kind: 'user', text: userText },
    { kind: 'assistant_reply', text: 'A green rectangle. I drew one too.', attachments: [join(out, 'reply.png'), join(out, 'reply.txt')] },
  ];
  await ev(`(() => { S.log = sessionTurnsToLog(${JSON.stringify(turns)}); render(); return true; })()`);
  await app.waitFor(`!!document.querySelector('.turn.usr')`, 'the stored user turn');
  const usr = await ev(`(() => { const t = document.querySelector('.turn.usr'); return {text: t.innerText,
    bubble: (t.querySelector('.bubble') || {}).textContent || null, chips: t.querySelectorAll('.attsent .attchip').length}; })()`);
  check('history: the user message shows its caption', usr.bubble === caption, JSON.stringify(usr.bubble));
  check('history: and a chip, not the raw [attachments] block', usr.chips === 1 && !/\[attachments\]|os\.fs\.read|inbox\/desktop/.test(usr.text), JSON.stringify(usr));

  const has408 = await ev(`typeof replyFilesStrip === 'function' && typeof openImageViewer === 'function' && !!(window.atomic && window.atomic.imageDataUrl)`);
  if (!has408) {
    skip('history: inline reply picture, reply file chip, viewer', 'ATO-408 is not in this build');
  } else {
    await app.waitFor(`!!document.querySelector('.turn.usr .attchip.is-img img.attthumb')`, 'the user image thumbnail', { timeout: 15000 });
    check('history: the user image chip loads its thumbnail', true);
    await app.waitFor(`!!document.querySelector('[data-chat-img] img')`, 'the inline reply picture', { timeout: 15000 });
    check('history: the reply shows its picture inline', true);
    check('history: and its text file as a chip', await ev(`[...document.querySelectorAll('.replyfiles .filechip')].some((b) => /reply\\.txt/.test(b.textContent))`));
    await shot('3-history');
    await app.clickSel('.turn.usr .attchip.is-img');
    await app.waitFor(`!!document.querySelector('.imgview')`, 'the viewer', { timeout: 15000 });
    check('history: clicking the sent image opens the viewer', true);
    await shot('3-viewer');
    await app.press('Escape');
    await app.waitFor(`!document.querySelector('.imgview')`, 'the viewer closed', { timeout: 5000 });
    check('history: Escape closes the viewer', true);
  }

  // ---- 4. copy gives the caption ----
  await ev(`(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = String(t); return Promise.resolve(); }; return true; })()`);
  await app.clickSel('.turn.usr [data-copy]');
  await app.waitFor(`window.__copied !== null`, 'the copy');
  check('copy: the user message copies its caption only', (await ev('window.__copied')) === caption, JSON.stringify(await ev('window.__copied')));

  // ---- 5. send: caption + the channels' block ----
  await ev(`(() => { S.log = []; render(); return true; })()`);
  await app.waitFor(`document.querySelectorAll('#attstrip .attchip').length === 3`, 'the three chips still waiting');
  await app.clickSel('#entry');
  await app.type('look at these');
  const sentBefore = await ev('S.history.length');
  await app.press('Enter');
  await app.waitFor(`S.history.length > ${sentBefore}`, 'the message sent', { timeout: 15000 });
  const sent = await ev('S.history[S.history.length - 1].content');
  const lines = sent.split('\n');
  check('send: the caption, a blank line, then [attachments]', lines[0] === 'look at these' && lines[1] === '' && lines[2] === '[attachments]', JSON.stringify(lines.slice(0, 3)));
  const items = lines.slice(3, -1);
  const lineRe = /^- (.+) \(([^,()]+), (\d+(?:\.\d+)? (?:B|KB|MB))\)$/;
  const parsed = items.map((l) => lineRe.exec(l));
  check('send: one line per file, in the inbox format', items.length === 3 && parsed.every(Boolean), JSON.stringify(items));
  check('send: ends with the channel inbox hint line, byte for byte', !!HINT && lines[lines.length - 1] === HINT, JSON.stringify(lines[lines.length - 1]));
  const files = parsed.filter(Boolean).map((m) => ({ path: m[1], mime: m[2], size: m[3] }));
  check('send: every file is under <state>/inbox/desktop/<day>/ and exists', files.length === 3 && files.every((f) => f.path.startsWith(inboxDay + sep) && existsSync(f.path)), JSON.stringify(files.map((f) => f.path)));
  check('send: sizes are the files\' own, formatted as the inbox does', files.every((f) => existsSync(f.path) && formatBytes(statSync(f.path).size) === f.size), JSON.stringify(files.map((f) => f.size)));
  check('send: types come from the bytes', JSON.stringify(files.map((f) => f.mime)) === JSON.stringify(['image/png', 'image/png', 'text/markdown']), JSON.stringify(files.map((f) => f.mime)));
  check('send: the chips are cleared', (await ev(`document.querySelectorAll('#attstrip .attchip').length`)) === 0);
  check('send: the transcript shows chips, not the block', await ev(`(() => { const t = [...document.querySelectorAll('.turn.usr')].pop(); return !!t && t.querySelectorAll('.attsent .attchip').length === 3 && !/\\[attachments\\]/.test(t.innerText); })()`));
  await shot('5-sent');
} catch (err) {
  check('run finished', false, err instanceof Error ? err.message : String(err));
} finally {
  await app.close();
  await sleep(200);
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
