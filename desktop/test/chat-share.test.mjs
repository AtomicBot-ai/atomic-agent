import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shareChat, registerChatShareIpc, shareGistArgs, shareAgentArgs, shareTarget, parseShareWire, removedLine, titleFromMarkdown, shareErrorText, gistOutcome } = require('../out/main/chat-share.js');
const { chatShareToast } = require('../renderer/chat-share.js');
const { chatMenuItems } = require('../renderer/chat-list.js');

/* ATO-581: the chat row's Share chat… */
function wireFor(args) {
  const i = args.indexOf('--out');
  const format = args[args.indexOf('--format') + 1];
  const file = i >= 0 ? args[i + 1] : `/state/shared-chats/chat-s-1.${format}`;
  return JSON.stringify({ ok: true, file, sessionId: 's-1', format, messages: 4, removed: { secrets: 1, paths: 2, personal: 0, reasoning: 0 } });
}

function harness(over = {}) {
  const agent = [];
  const gh = [];
  const boxes = [];
  const answers = [...(over.answers ?? [0])];
  const shown = [];
  const copied = [];
  const deps = {
    ipcMain: { handle: () => {} },
    dialog: {
      showSaveDialog: async () => over.pick ?? { canceled: false, filePath: '/tmp/out/chat.html' },
      showMessageBox: async (opts) => { boxes.push(opts); return { response: answers.shift() ?? 0 }; },
    },
    window: () => null,
    runAgent: async (args) => { agent.push(args); return over.agent ? over.agent(args) : { ok: true, stdout: `Saved\n${wireFor(args)}\n`, stderr: '' }; },
    runGh: async (args) => { gh.push(args); return over.gh ?? { code: 0, stdout: 'https://gist.github.com/me/abc123\n', stderr: '' }; },
    isRemote: () => over.remote === true,
    showInFolder: (p) => shown.push(p),
    copyText: (t) => copied.push(t),
    openUrl: () => {},
    readText: async () => '# Trip plan\n\n## You\n\nhi\n',
  };
  return { deps, agent, gh, boxes, shown, copied };
}

test('Share chat… saves the redacted file where the person picked, and uploads nothing by default', async () => {
  const h = harness();
  const res = await shareChat(h.deps, 's-1');
  assert.deepEqual(res, { ok: true, path: '/tmp/out/chat.html' });
  assert.deepEqual(h.agent, [['share', '--session', 's-1', '--format', 'html', '--out', '/tmp/out/chat.html', '--json']]);
  assert.equal(h.gh.length, 0);
  assert.equal(h.boxes.length, 1);
  assert.deepEqual(h.boxes[0].buttons, ['Done', 'Show in folder', 'Create secret gist…']);
  assert.equal(h.boxes[0].defaultId, 0);
  assert.match(h.boxes[0].detail, /1 key or secret, 2 folder paths/);
});

test('Show in folder reveals the saved file', async () => {
  const h = harness({ answers: [1] });
  await shareChat(h.deps, 's-1');
  assert.deepEqual(h.shown, ['/tmp/out/chat.html']);
  assert.equal(h.gh.length, 0);
});

test('the gist offer alone uploads nothing: Cancel on the confirm is the default and stops it', async () => {
  const h = harness({ answers: [2, 0] });
  const res = await shareChat(h.deps, 's-1');
  assert.deepEqual(res, { ok: true, path: '/tmp/out/chat.html' });
  assert.equal(h.gh.length, 0);
  assert.deepEqual(h.boxes[1].buttons, ['Cancel', 'Upload']);
  assert.equal(h.boxes[1].defaultId, 0);
  assert.equal(h.boxes[1].cancelId, 0);
  assert.match(h.boxes[1].detail, /anyone with the link can open it/);
});

test('after both yeses an HTML save uploads a Markdown copy as a SECRET gist and copies the link', async () => {
  const h = harness({ answers: [2, 1, 0] });
  const res = await shareChat(h.deps, 's-1');
  assert.deepEqual(res, { ok: true, path: '/tmp/out/chat.html', gistUrl: 'https://gist.github.com/me/abc123' });
  assert.deepEqual(h.agent[1], ['share', '--session', 's-1', '--format', 'md', '--json']);
  assert.deepEqual(h.gh, [['gist', 'create', '/state/shared-chats/chat-s-1.md', '--desc', 'Atomic Agent chat: Trip plan']]);
  assert.ok(!h.gh[0].includes('--public') && !h.gh[0].includes('-p'));
  assert.deepEqual(h.copied, ['https://gist.github.com/me/abc123']);
});

test('an HTML save writes the Markdown copy before the confirm, names it there, and uploads exactly that file', async () => {
  let n = 0;
  const h = harness({
    answers: [2, 1, 0],
    agent: (args) => {
      n += 1;
      if (args.includes('--out')) return { ok: true, stdout: wireFor(args), stderr: '' };
      // Each later run would see a chat that grew and write another file: only the first one may go up.
      const file = `/state/shared-chats/copy-${n}.md`;
      return { ok: true, stdout: JSON.stringify({ ok: true, file, sessionId: 's-1', format: 'md', messages: 4 + n, removed: {} }), stderr: '' };
    },
  });
  await shareChat(h.deps, 's-1');
  assert.equal(h.agent.length, 2, 'no Markdown copy is regenerated after the yes');
  assert.match(h.boxes[1].detail, /\/state\/shared-chats\/copy-2\.md/);
  assert.match(h.boxes[1].detail, /6 messages/);
  assert.equal(h.gh[0][2], '/state/shared-chats/copy-2.md');
});

test('a Markdown save is uploaded as it is', async () => {
  const h = harness({ answers: [2, 1, 0], pick: { canceled: false, filePath: '/tmp/out/chat.md' } });
  await shareChat(h.deps, 's-1');
  assert.equal(h.agent.length, 1);
  assert.match(h.boxes[1].detail, /the file you saved \(4 messages\):\n\/tmp\/out\/chat\.md/);
  assert.equal(h.gh[0][2], '/tmp/out/chat.md');
});

test('gh missing or signed out: the file stays and the reason is said', async () => {
  const h = harness({ answers: [2, 1], gh: { code: 127, stdout: '', stderr: '', missing: true } });
  const res = await shareChat(h.deps, 's-1');
  assert.equal(res.ok, true);
  assert.match(res.gistError, /not installed/);
  assert.match(gistOutcome({ code: 1, stdout: '', stderr: 'HTTP 401\n' }).error, /HTTP 401.*gh auth status/);
});

test('canceled dialog, bad id, remote agent and an old agent', async () => {
  assert.deepEqual(await shareChat(harness({ pick: { canceled: true } }).deps, 's-1'), { ok: false, reason: 'canceled' });
  assert.deepEqual(await shareChat(harness().deps, ''), { ok: false, reason: 'bad-id' });
  assert.deepEqual(await shareChat(harness().deps, '--gist'), { ok: false, reason: 'bad-id' });
  const remote = await shareChat(harness({ remote: true }).deps, 's-1');
  assert.match(remote.error, /stored on this computer/);
  const old = await shareChat(harness({ agent: () => ({ ok: false, stdout: '', stderr: 'unknown command: share\n', error: 'x' }) }).deps, 's-1');
  assert.equal(old.error, 'This agent version cannot share chats. Update Atomic Agent.');
});

test('helpers', () => {
  assert.deepEqual(shareGistArgs('/f.md', ''), ['gist', 'create', '/f.md', '--desc', 'Atomic Agent chat: untitled']);
  assert.deepEqual(shareAgentArgs('s-1', 'md'), ['share', '--session', 's-1', '--format', 'md', '--json']);
  assert.deepEqual(shareTarget('/x/a'), { format: 'html', path: '/x/a.html' });
  assert.deepEqual(shareTarget('/x/a.MD'), { format: 'md', path: '/x/a.MD' });
  assert.equal(parseShareWire('Saved\nnot json'), null);
  assert.equal(removedLine({}), 'Nothing needed removing.');
  assert.equal(titleFromMarkdown('# Hello there\n\n## You'), 'Hello there');
  assert.equal(shareErrorText({ ok: false, stdout: '', stderr: 'no chat with id x\n' }), 'no chat with id x');
});

test('the IPC channel is agent:shareSession', () => {
  const channels = [];
  registerChatShareIpc({ ...harness().deps, ipcMain: { handle: (ch) => channels.push(ch) } });
  assert.deepEqual(channels, ['agent:shareSession']);
});

test('the row menu has Share chat… for a stored chat only, after Export…', () => {
  const verbs = chatMenuItems({ exportable: true }).map((i) => i.verb);
  assert.equal(verbs.indexOf('share'), verbs.indexOf('export') + 1);
  assert.ok(!chatMenuItems({}).some((i) => i.verb === 'share'));
});

test('the window says where it went, the link, or why not', () => {
  assert.deepEqual(chatShareToast({ ok: true, path: '/tmp/a.html' }), { t: 'Redacted chat saved', s: '/tmp/a.html' });
  assert.equal(chatShareToast({ ok: true, path: '/a', gistUrl: 'https://gist.github.com/x' }).s, 'https://gist.github.com/x');
  assert.equal(chatShareToast({ ok: true, path: '/a', gistError: 'no gh' }).kind, 'bad');
  assert.equal(chatShareToast({ ok: false, reason: 'canceled' }), null);
});
