import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { repoKey, worktreeName, dirInWorktree, parseWorktreePorcelain, isInside, dirtyReason, NOT_GIT } = require('../out/main/chat-worktree-git.js');
const { ChatWorktrees, registerChatWorktreeIpc, worktreesDir } = require('../out/main/chat-worktree-ipc.js');
const { worktreeRowView } = require('../renderer/chat-worktree.js');

/* ATO-576: a project's "New chat in its own branch" and its worktree list. */

test('the folder and branch names match the agent\'s /new worktree', () => {
  assert.match(repoKey('/Users/me/my app'), /^my-app-[0-9a-f]{8}$/);
  assert.equal(worktreeName('s-1a2b3c4d5e6f'), '1a2b3c4d');
  assert.equal(worktreeName('0f9e8d7c-1111-2222-3333-444455556666'), '0f9e8d7c');
  assert.equal(dirInWorktree('/r', '/r/web', '/w/x'), '/w/x/web');
  assert.equal(dirInWorktree('/r', '/r', '/w/x'), '/w/x');
});

test('git worktree list --porcelain is read block by block', () => {
  const rows = parseWorktreePorcelain('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /s/wt/r-1/aa\nHEAD def\nbranch refs/heads/atomic/session-aa\nlocked\n\nworktree /x\nHEAD 1\ndetached\n');
  assert.deepEqual(rows.map((r) => [r.path, r.branch, r.locked]), [['/r', 'main', false], ['/s/wt/r-1/aa', 'atomic/session-aa', true], ['/x', null, false]]);
});

test('only paths under the agent\'s worktrees folder count', () => {
  assert.ok(isInside('/s/worktrees', '/s/worktrees/r-1/aa', 'linux'));
  assert.ok(!isInside('/s/worktrees', '/s/worktrees', 'linux'));
  assert.ok(!isInside('/s/worktrees', '/s/worktrees-evil/aa', 'linux'));
  assert.ok(isInside('C:\\S\\worktrees', 'c:\\s\\worktrees\\a', 'win32'));
});

test('a worktree with any change or a kept ignored file is not removable; caches are fine', () => {
  assert.equal(dirtyReason(''), null);
  assert.equal(dirtyReason('!! node_modules/\0!! web/__pycache__/\0'), null);
  assert.match(dirtyReason(' M a.ts\0'), /nobody committed/);
  assert.match(dirtyReason('?? new.txt\0'), /nobody committed/);
  assert.match(dirtyReason('!! .env\0'), /\.env/);
});

/* A fake git over a real temp folder: `worktree add` makes the folder. */
function setup(over = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atag-wt-')));
  const repo = join(base, 'repo'); mkdirSync(repo);
  const state = join(base, 'state'); mkdirSync(state);
  const calls = [];
  const made = [];
  const git = async (args, cwd) => {
    calls.push([args.join(' '), cwd]);
    const a = args.join(' ');
    if (a === 'rev-parse --show-toplevel') return over.notGit ? { code: 128, stdout: '', stderr: 'not a git repository' } : { code: 0, stdout: repo + '\n', stderr: '' };
    if (a.startsWith('rev-parse --verify -q HEAD')) return { code: 0, stdout: 'c0ffee\n', stderr: '' };
    if (a.startsWith('rev-parse --verify -q refs/heads/')) return { code: 1, stdout: '', stderr: '' };
    if (a === 'symbolic-ref --short -q HEAD') return { code: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[4], { recursive: true }); made.push(args[4]); return { code: 0, stdout: '', stderr: '' }; }
    if (a === 'worktree list --porcelain') return { code: 0, stdout: [`worktree ${repo}\nHEAD c0ffee\nbranch refs/heads/main\n`, ...made.map((p) => `worktree ${p}\nHEAD c0ffee\nbranch refs/heads/atomic/session-${p.split('/').pop()}\n`)].join('\n'), stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: over.status ?? '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return over.removeFails ? { code: 128, stdout: '', stderr: 'fatal: cannot remove: file in use' } : { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const repointed = [];
  const wt = new ChatWorktrees({
    stateDir: state, git, isRemote: () => over.remote === true, newChatId: () => '0f9e8d7c-aaaa-bbbb-cccc-ddddeeeeffff',
    projectFolder: (id) => (id === 'p1' ? repo : null),
    repoint: async (id, dir) => { repointed.push([id, dir]); return over.moved ?? (over.busy ? { busy: true } : {}); },
  });
  return { wt, repo, state, calls, repointed };
}

test('New chat in its own branch makes the worktree at once, and the project\'s next new chat takes it once', async () => {
  const h = setup();
  const res = await h.wt.start('p1');
  assert.equal(res.ok, true);
  assert.equal(res.branch, 'atomic/session-0f9e8d7c');
  assert.ok(res.path.startsWith(worktreesDir(h.state)));
  assert.ok(h.calls.some(([a]) => a.startsWith('worktree add -b atomic/session-0f9e8d7c ') && a.endsWith(' c0ffee')));
  assert.equal(h.wt.take('p2'), null);
  assert.deepEqual(h.wt.take('p1'), { chatId: '0f9e8d7c-aaaa-bbbb-cccc-ddddeeeeffff', dir: res.path });
  assert.equal(h.wt.take('p1'), null);
  const records = JSON.parse(readFileSync(join(worktreesDir(h.state), 'desktop-chats.json'), 'utf8'));
  assert.equal(records[res.path].sessionId, '0f9e8d7c-aaaa-bbbb-cccc-ddddeeeeffff');
});

test('a folder outside git, a project with no folder and a remote agent are refused in words', async () => {
  assert.deepEqual(await setup({ notGit: true }).wt.start('p1'), { ok: false, error: NOT_GIT });
  assert.equal((await setup().wt.start('nope')).ok, false);
  assert.match((await setup({ remote: true }).wt.start('p1')).error, /another one/);
});

test('the list shows only the agent\'s worktrees; Remove moves the chat back, then git worktree remove and branch -d', async () => {
  const h = setup();
  const made = await h.wt.start('p1');
  const listed = await h.wt.list('p1');
  assert.deepEqual(listed.rows.map((r) => [r.path, r.removable, r.sessionId]), [[made.path, true, '0f9e8d7c-aaaa-bbbb-cccc-ddddeeeeffff']]);
  const res = await h.wt.remove('p1', made.path);
  assert.deepEqual(res, { ok: true, branchKept: false });
  assert.deepEqual(h.repointed, [['0f9e8d7c-aaaa-bbbb-cccc-ddddeeeeffff', h.repo]]);
  const verbs = h.calls.map(([a]) => a);
  assert.ok(verbs.includes(`worktree remove ${made.path}`));
  assert.ok(!verbs.some((a) => /--force|-D\b/.test(a)));
  assert.ok(verbs.includes('branch -d atomic/session-0f9e8d7c'));
  assert.equal(h.wt.take('p1'), null);
});

test('Remove refuses a dirty worktree, a path that is not the agent\'s, and a chat mid-turn', async () => {
  const dirty = setup({ status: ' M a.ts\0' });
  const d = await dirty.wt.start('p1');
  assert.match((await dirty.wt.remove('p1', d.path)).error, /nobody committed/);
  assert.equal(dirty.repointed.length, 0);
  const h = setup();
  assert.match((await h.wt.remove('p1', h.repo)).error, /not one of the agent/);
  const busy = setup({ busy: true });
  const b = await busy.wt.start('p1');
  assert.match((await busy.wt.remove('p1', b.path)).error, /running a turn/);
  assert.ok(existsSync(b.path));
  assert.ok(!busy.calls.some(([a]) => a.startsWith('worktree remove')));
});

test('Remove keeps the worktree when its chat cannot be moved out (agent refused, old or unreachable)', async () => {
  for (const moved of [{ supported: true, error: 'That folder is not allowed' }, { supported: false }]) {
    const h = setup({ moved });
    const made = await h.wt.start('p1');
    const res = await h.wt.remove('p1', made.path);
    assert.equal(res.ok, false);
    assert.match(res.error, /could not be moved back/);
    assert.ok(!h.calls.some(([a]) => a.startsWith('worktree remove')), 'no git worktree remove while the chat still points there');
    assert.ok(existsSync(made.path));
  }
});

test('a failed git worktree remove after the chat moved says so', async () => {
  const h = setup({ removeFails: true });
  const made = await h.wt.start('p1');
  const res = await h.wt.remove('p1', made.path);
  assert.equal(res.ok, false);
  assert.match(res.error, /file in use/);
  assert.match(res.error, /now works in the project's folder/);
});

test('the IPC channels', () => {
  const ch = [];
  registerChatWorktreeIpc({ handle: (c) => ch.push(c) }, setup().wt);
  assert.deepEqual(ch, ['worktree:newChat', 'worktree:list', 'worktree:remove']);
});

test('a row says its branch and why Remove is off', () => {
  assert.deepEqual(worktreeRowView({ path: '/s/worktrees/r/aa', branch: 'atomic/session-aa', removable: true }), { name: 'atomic/session-aa', path: '/s/worktrees/r/aa', canRemove: true, why: '' });
  assert.equal(worktreeRowView({ path: '/s/worktrees/r/aa', branch: null, removable: false, reason: 'It has changes' }).name, 'aa');
  assert.equal(worktreeRowView({ removable: false, reason: 'x' }).why, 'x');
});
