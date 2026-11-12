import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { exportChatToFile, registerChatExportIpc, chatExportTarget, chatExportDefaultName, chatExportErrorText, CHAT_EXPORT_FILTERS } = require('../out/main/chat-export.js');
const { chatExportToast } = require('../renderer/chat-export.js');
const { chatMenuItems } = require('../renderer/chat-list.js');

/* ATO-1054: the chat row's Export… */
function harness(over = {}) {
  const fetched = [];
  const written = [];
  const dialogs = [];
  const deps = {
    ipcMain: { handle: () => {} },
    dialog: { showSaveDialog: async (_w, o) => { dialogs.push(o || _w); return over.pick ?? { canceled: false, filePath: '/tmp/out/Trip plan.md' }; } },
    window: () => null,
    fetchExport: async (id, format) => {
      fetched.push(format);
      if (over.fail) throw new Error(over.fail);
      if (format === 'docx') return { id, format, filename: 'Trip plan.docx', mimeType: 'x', encoding: 'base64', content: Buffer.from('PKdocx').toString('base64') };
      if (format === 'html') return { id, format, filename: 'Trip plan.html', mimeType: 'x', encoding: 'utf8', content: '<p>hi</p>' };
      return { id, format, filename: 'Trip plan.md', mimeType: 'x', encoding: 'utf8', content: '# Trip plan\n' };
    },
    printPdf: async (html) => Buffer.from('%PDF ' + html),
    writeFile: async (path, data) => { written.push({ path, data }); },
  };
  return { deps, fetched, written, dialogs };
}

test('the save dialog offers Markdown first, then PDF, Word and HTML, named after the chat', async () => {
  const h = harness();
  const res = await exportChatToFile(h.deps, 's-1');
  assert.deepEqual(res, { ok: true, path: '/tmp/out/Trip plan.md', kind: 'markdown' });
  assert.equal(h.dialogs[0].defaultPath, 'Trip plan.md');
  assert.deepEqual(CHAT_EXPORT_FILTERS.map((f) => f.extensions[0]), ['md', 'pdf', 'docx', 'html']);
  assert.deepEqual(h.fetched, ['markdown']);
  assert.equal(h.written[0].data, '# Trip plan\n');
});

test('a .docx path writes the agent\'s Word bytes', async () => {
  const h = harness({ pick: { canceled: false, filePath: '/tmp/a.docx' } });
  const res = await exportChatToFile(h.deps, 's-1');
  assert.equal(res.kind, 'docx');
  assert.deepEqual(h.fetched, ['markdown', 'docx']);
  assert.equal(Buffer.from(h.written[0].data).toString(), 'PKdocx');
});

test('a .pdf path prints the agent\'s HTML; .html saves it as is', async () => {
  const pdf = harness({ pick: { canceled: false, filePath: '/tmp/a.pdf' } });
  assert.equal((await exportChatToFile(pdf.deps, 's-1')).kind, 'pdf');
  assert.equal(Buffer.from(pdf.written[0].data).toString(), '%PDF <p>hi</p>');
  const html = harness({ pick: { canceled: false, filePath: '/tmp/a.HTML' } });
  assert.equal((await exportChatToFile(html.deps, 's-1')).kind, 'html');
  assert.equal(html.written[0].data, '<p>hi</p>');
});

test('cancel writes nothing; a bad id never reaches the agent; an old agent says to update', async () => {
  const c = harness({ pick: { canceled: true } });
  assert.deepEqual(await exportChatToFile(c.deps, 's-1'), { ok: false, reason: 'canceled' });
  assert.equal(c.written.length, 0);
  const b = harness();
  assert.deepEqual(await exportChatToFile(b.deps, ''), { ok: false, reason: 'bad-id' });
  assert.deepEqual(b.fetched, []);
  const old = harness({ fail: '/api/sessions/s-1/export?format=markdown → HTTP 404' });
  const res = await exportChatToFile(old.deps, 's-1');
  assert.equal(res.reason, 'failed');
  assert.match(res.error, /cannot export chats\. Update Atomic Agent/);
});

test('the file type comes from the extension; none or unknown is Markdown', () => {
  assert.deepEqual(chatExportTarget('/x/a.pdf'), { kind: 'pdf', path: '/x/a.pdf' });
  assert.deepEqual(chatExportTarget('/x/a.htm'), { kind: 'html', path: '/x/a.htm' });
  assert.deepEqual(chatExportTarget('/x/a'), { kind: 'markdown', path: '/x/a.md' });
  assert.deepEqual(chatExportTarget('/x/a.txt'), { kind: 'markdown', path: '/x/a.txt.md' });
  assert.equal(chatExportDefaultName('Trip plan.md', 'pdf'), 'Trip plan.pdf');
  assert.equal(chatExportDefaultName('', 'docx'), 'chat.docx');
  assert.equal(chatExportErrorText(new Error('boom')), 'boom');
});

test('the IPC channel is agent:exportSession', () => {
  const channels = [];
  registerChatExportIpc({ ...harness().deps, ipcMain: { handle: (ch) => channels.push(ch) } });
  assert.deepEqual(channels, ['agent:exportSession']);
});

test('the row menu has Export… for a stored chat only, before Delete…', () => {
  assert.deepEqual(chatMenuItems({ folders: true, exportable: true }).map((i) => i.verb), ['pin', 'unread', 'rename', 'fpick', 'export', 'delask']);
  assert.ok(!chatMenuItems({}).some((i) => i.verb === 'export'));
});

test('the window says where it went, and nothing on cancel', () => {
  assert.deepEqual(chatExportToast({ ok: true, path: '/tmp/a.md' }), { t: 'Chat exported', s: '/tmp/a.md' });
  assert.equal(chatExportToast({ ok: false, reason: 'canceled' }), null);
  assert.equal(chatExportToast({ ok: false, reason: 'failed', error: 'x' }).kind, 'bad');
});
