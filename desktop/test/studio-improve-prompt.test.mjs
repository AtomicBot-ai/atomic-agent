// Studio › Improve prompt (ATO-809, ATO-900 item 4): the button under the prompt
// box (renderer/studio/improve-prompt.js) and main's one-shot rewrite
// (main/studio-improve-prompt.ts, against the built output).
// Run: npm run build && node --test test/studio-improve-prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../renderer/studio/improve-prompt.js');
const M = require('../out/main/studio-improve-prompt.js');

const attr = (v) => 'data-x="' + v + '"';
const ready = (over) => Object.assign(R.studioImproveBlank(), { ready: true }, over || {});

/* ---------- the button (renderer) ---------- */

test('the button is drawn even before anything is known, greyed with a reason', () => {
  const html = R.studioImproveHTML('', R.studioImproveBlank(), attr);
  assert.match(html, /class="st-improve off"/);
  assert.match(html, /Improve prompt/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /data-x="improve"/);
});

test('greyed with "Type a prompt first" while the box is empty, even with a chat model', () => {
  assert.equal(R.studioImproveWhy('   ', ready()), R.STUDIO_IMPROVE_EMPTY);
  assert.match(R.studioImproveHTML('', ready(), attr), /title="Type a prompt first"/);
});

test('greyed with main\'s reason when no chat model can answer', () => {
  const st = ready({ ready: false, why: 'Set up a chat model in Settings to improve prompts.' });
  assert.equal(R.studioImproveWhy('a fox', st), 'Set up a chat model in Settings to improve prompts.');
  assert.match(R.studioImproveHTML('a fox', st, attr), /title="Set up a chat model in Settings to improve prompts\."/);
});

test('live with text and a chat model; busy while a rewrite runs', () => {
  assert.equal(R.studioImproveWhy('a fox', ready()), '');
  const html = R.studioImproveHTML('a fox', ready(), attr);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.doesNotMatch(html, /st-improve off/);
  const busy = R.studioImproveHTML('a fox', ready({ busy: true }), attr);
  assert.match(busy, /Improving/);
  assert.match(busy, /aria-disabled="true"/);
});

test('Undo after a rewrite and the last error are drawn, escaped', () => {
  const html = R.studioImproveHTML('a fox', ready({ undo: 'a fox', err: '<b>no</b>' }), attr);
  assert.match(html, /data-x="improve-undo"/);
  assert.ok(html.includes('&lt;b&gt;no&lt;/b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('an older app build without the bridge call greys the button instead of hiding it', async () => {
  const st = R.studioImproveBlank();
  await R.studioImproveCheck({}, st);
  assert.equal(st.ready, false);
  assert.match(R.studioImproveHTML('a fox', st, attr), /aria-disabled="true"/);
});

test('a run puts main\'s prompt back and keeps the old one for Undo; a failure keeps the text and says why', async () => {
  const st = ready();
  const ok = { improvePrompt: async (kind, p) => ({ ok: true, data: { prompt: '  ' + kind + ': ' + p + ', golden hour ' } }) };
  assert.equal(await R.studioImproveRun(ok, 'video', 'a fox', st), 'video: a fox, golden hour');
  assert.equal(st.undo, 'a fox');
  assert.equal(st.busy, false);

  const st2 = ready();
  const no = { improvePrompt: async () => ({ ok: false, error: { code: 'NO_CHAT_MODEL', message: 'Set up a chat model.' } }) };
  assert.equal(await R.studioImproveRun(no, 'image', 'a fox', st2), null);
  assert.equal(st2.err, 'Set up a chat model.');
  assert.equal(st2.ready, false);
  assert.equal(st2.undo, null);

  // Nothing is sent for an empty box.
  let sent = false;
  assert.equal(await R.studioImproveRun({ improvePrompt: async () => { sent = true; } }, 'image', '  ', ready()), null);
  assert.equal(sent, false);
});

test('a rewrite that comes back after the box was edited keeps the typed text', () => {
  const st = ready({ undo: 'a fox' });
  assert.equal(R.studioImproveLands(st, 'a fox', 'a fox'), true);
  assert.equal(st.undo, 'a fox');
  assert.equal(R.studioImproveLands(st, 'a fox', 'a fox in the snow'), false);
  assert.equal(st.undo, null);
  assert.equal(st.err, R.STUDIO_IMPROVE_EDITED);
});

/* ---------- wiring (both pages) ---------- */

test('index.html loads improve-prompt.js before the Studio pages', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (s) => index.indexOf('<script src="' + s + '">');
  assert.ok(at('studio/improve-prompt.js') > 0);
  for (const page of ['studio/images.js', 'studio/images-view.js', 'studio/video.js']) assert.ok(at('studio/improve-prompt.js') < at(page), page);
});

test('both pages draw the button with the prompt box and handle its verbs', () => {
  const images = readFileSync(new URL('../renderer/studio/images.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  const video = readFileSync(new URL('../renderer/studio/video.js', import.meta.url), 'utf8');
  assert.match(view, /studioImproveHTML\(f\.prompt, IM\.improve/);
  assert.match(images, /case 'improve':/);
  assert.match(images, /case 'improve-undo':/);
  assert.match(images, /studioImproveCheck\(/);
  assert.match(video, /studioImproveHTML\(f\.prompt, S\.improve/);
  assert.match(video, /case 'improve':/);
  assert.match(video, /case 'improve-undo':/);
  assert.match(video, /studioImproveCheck\(/);
  // The answer lands only on the text it was asked for; the video page also sets a focused box's value.
  assert.match(images, /studioImproveLands\(st, sent, IM\.form\.prompt\)/);
  assert.match(video, /studioImproveLands\(st, sent, S\.form\.prompt\)/);
  assert.match(video, /if \(ta\) ta\.value = next;/);
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.match(preload, /improveReady: \(\) => ipcRenderer\.invoke\("studio:improveReady"\)/);
  assert.match(preload, /improvePrompt: \(kind: "image" \| "video", prompt: string\) => ipcRenderer\.invoke\("studio:improvePrompt", kind, prompt\)/);
});

test('no em dash in the Improve prompt text', () => {
  for (const f of ['../renderer/studio/improve-prompt.js', '../main/studio-improve-prompt.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const strings = src.match(/(['"`])[^'"`\n]*\1/g) || [];
    assert.equal(strings.filter((s) => s.includes('—')).length, 0, f);
  }
});

/* ---------- main: which model is asked ---------- */

const cloud = { id: 'openrouter', kind: 'openrouter', apiKey: 'sk-test', defaultChatModel: 'acme/chat-1' };
const yes = () => true;

test('the active cloud provider and its chat model', () => {
  const r = M.improveRoute({ llm: { activeTextProvider: 'openrouter', providers: [cloud] } }, yes);
  assert.equal(r.ok, true);
  assert.equal(r.target.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(r.target.model, 'acme/chat-1');
  assert.equal(r.target.local, false);
});

test('Fusion asks its orchestrator', () => {
  const r = M.improveRoute({ llm: {
    activeTextProvider: 'local-llama',
    providers: [{ id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' }, cloud],
    runMode: { mode: 'fusion', fusion: { orchestratorProvider: 'openrouter', orchestratorModel: 'acme/planner' } },
  } }, yes);
  assert.equal(r.ok, true);
  assert.equal(r.target.model, 'acme/planner');
});

test('a local llama-server is asked on its own URL', () => {
  const r = M.improveRoute({
    localModels: { mode: 'managed', managed: { modelId: 'qwen-4b', port: 19091 } },
    llm: { activeTextProvider: 'local-llama', providers: [{ id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' }] },
  }, yes);
  assert.equal(r.ok, true);
  assert.equal(r.target.url, 'http://127.0.0.1:19091/v1/chat/completions');
  assert.equal(r.target.local, true);
});

test('no usable chat model: a reason for the tooltip, never a request', () => {
  assert.equal(M.improveRoute({ localModels: { mode: 'managed', managed: {} } }, yes).ok, false);
  assert.equal(M.improveRoute({ llm: { activeTextProvider: 'gone', providers: [] } }, yes).why, M.IMPROVE_NO_MODEL);
  const noModel = M.improveRoute({ llm: { activeTextProvider: 'openrouter', providers: [{ ...cloud, defaultChatModel: undefined }] } }, yes);
  assert.equal(noModel.ok, false);
  const noKey = M.improveRoute({ llm: { activeTextProvider: 'openrouter', providers: [cloud] } }, () => false);
  assert.equal(noKey.ok, false);
  assert.match(noKey.why, /API key/);
  const sub = M.improveRoute({ llm: { activeTextProvider: 'claude', providers: [{ id: 'claude', kind: 'subscription-cli' }] } }, yes);
  assert.equal(sub.ok, false);
});

test('the request asks for the prompt only, for the page\'s kind, within the contract limit', () => {
  const body = M.improveRequestBody('acme/chat-1', 'video', '  ' + 'x'.repeat(9000));
  assert.equal(body.model, 'acme/chat-1');
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /video clip/);
  assert.match(body.messages[0].content, /improved prompt only/);
  assert.equal(body.messages[1].content.length, M.IMPROVE_PROMPT_MAX);
  assert.match(M.improveRequestBody('m', 'image', 'a fox').messages[0].content, /picture/);
});

test('the answer is cleaned: thinking, fences, a label and wrapping quotes go', () => {
  const of = (content) => M.improvedPromptOf({ choices: [{ message: { content } }] });
  assert.equal(of('<think>hmm</think>\n"A red fox at dawn, mist."'), 'A red fox at dawn, mist.');
  assert.equal(of('```\nImproved prompt: a fox\n```'), 'a fox');
  assert.equal(of('Prompt: a fox'), 'a fox');
  assert.equal(of(''), '');
  assert.equal(M.improvedPromptOf(null), '');
  assert.equal(M.improvedPromptOf({ choices: [{ message: { content: [{ type: 'text', text: 'a fox' }] } }] }), 'a fox');
});

test('improvePrompt sends the key in the header only and returns the rewrite', async () => {
  const seen = [];
  const deps = {
    readConfig: async () => ({ ok: true, config: { llm: { activeTextProvider: 'openrouter', providers: [cloud] } } }),
    request: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ choices: [{ message: { content: 'A red fox at dawn.' } }] }), { status: 200 }); },
  };
  const r = await M.improvePrompt(deps, 'image', 'a fox');
  assert.deepEqual(r, { ok: true, data: { prompt: 'A red fox at dawn.' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test');
  assert.ok(!seen[0].init.body.includes('sk-test'));
});

test('improvePrompt: empty text, no chat model, a refused key and a paused local model each answer without throwing', async () => {
  const never = async () => { throw new Error('must not be called'); };
  const cfg = (config) => async () => ({ ok: true, config });
  assert.equal((await M.improvePrompt({ readConfig: cfg({}), request: never }, 'image', ' ')).error.code, 'INVALID_REQUEST');
  assert.equal((await M.improvePrompt({ readConfig: cfg({ llm: { activeTextProvider: 'gone', providers: [] } }), request: never }, 'image', 'a fox')).error.code, 'NO_CHAT_MODEL');
  const refused = await M.improvePrompt({
    readConfig: cfg({ llm: { activeTextProvider: 'openrouter', providers: [cloud] } }),
    request: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
  }, 'image', 'a fox');
  assert.equal(refused.error.code, 'IMPROVE_FAILED');
  assert.match(refused.error.message, /refused the API key/);
  const local = { localModels: { mode: 'managed', managed: { modelId: 'qwen-4b' } }, llm: { activeTextProvider: 'local-llama', providers: [{ id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091' }] } };
  const paused = await M.improvePrompt({ readConfig: cfg(local), localPaused: () => true, request: never }, 'video', 'a fox');
  assert.equal(paused.error.code, 'NO_CHAT_MODEL');
  assert.deepEqual(await M.improveReady({ readConfig: cfg(local), localPaused: () => false }), { ready: true, why: '' });
  const down = await M.improvePrompt({ readConfig: cfg(local), request: async () => { throw new TypeError('fetch failed'); } }, 'image', 'a fox');
  assert.equal(down.error.code, 'IMPROVE_FAILED');
});
