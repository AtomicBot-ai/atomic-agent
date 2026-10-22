// Media in the chat (renderer/chat-media.js): which reply files are videos,
// the video.generate card's words, and how `event: tool_update` frames fold
// into the running card (target, monotonic fraction, the progress line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../renderer/chat-media.js');

test('a reply file is a video, a picture or neither, by its extension', () => {
  assert.equal(M.chatMediaKind('/w/clip.mp4'), 'video');
  assert.equal(M.chatMediaKind('/w/CLIP.MP4'), 'video');
  assert.equal(M.chatMediaKind('/w/clip.webm'), 'video');
  assert.equal(M.chatMediaKind('/w/clip.m4v'), 'video');
  assert.equal(M.chatMediaKind('/w/cat.png'), 'image');
  assert.equal(M.chatMediaKind('/w/cat.JPEG'), 'image');
  // A QuickTime .mov often holds a codec Chromium cannot play: a chip, not a player.
  assert.equal(M.chatMediaKind('/w/clip.mov'), null);
  assert.equal(M.chatMediaKind('/w/clip.mp4.txt'), null);
  assert.equal(M.chatMediaKind('/w/notes'), null);
  assert.equal(M.chatMediaKind(''), null);
  assert.equal(M.chatMediaKind(null), null);
});

test('the video.generate card names the length and the model, like image.generate\'s', () => {
  assert.equal(M.videoToolLine({ prompt: 'a cat' }), 'Generated a video · 4 s · Veo 3.1 Fast');
  assert.equal(M.videoToolLine({ duration: 8, model: 'google/veo-3.1' }), 'Generated a video · 8 s · Veo 3.1');
  assert.equal(M.videoToolLine({ duration: 5, model: 'kwaivgi/kling-video-o1' }), 'Generated a video · 5 s · Kling Video O1');
  // Clipped live args do not parse: the tool's defaults.
  assert.equal(M.videoToolLine(null), 'Generated a video · 4 s · Veo 3.1 Fast');
  assert.equal(M.videoToolLine({ duration: 'x', model: 'local' }), 'Generated a video · 4 s · Veo 3.1 Fast');
  assert.equal(M.videoModelName('google/veo-3.1-fast'), 'Veo 3.1 Fast');
  assert.match(M.VIDEO_PAID_WHY, /^OpenRouter charges your account for this video\. Stop doesn't cancel the charge\.$/);
});

test('tool_update goes to the newest running card of that tool in that turn', () => {
  const log = [
    { k: 'tool', name: 'video.generate', ok: true, turn: 't1', id: 1 },
    { k: 'tool', name: 'video.generate', ok: null, turn: 't1', id: 2 },
    { k: 'reply', id: 3 },
    { k: 'tool', name: 'os.fs.write', ok: null, turn: 't1', id: 4 },
    { k: 'tool', name: 'video.generate', ok: null, turn: 't2', id: 5 },
  ];
  assert.equal(M.toolUpdateTarget(log, { tool: 'video.generate' }, 't1').id, 2);
  assert.equal(M.toolUpdateTarget(log, { tool: 'video.generate' }, 't2').id, 5);
  assert.equal(M.toolUpdateTarget(log, { tool: 'image.generate' }, 't1'), null);
  assert.equal(M.toolUpdateTarget(log, {}, 't1'), null);
  assert.equal(M.toolUpdateTarget(null, { tool: 'video.generate' }, 't1'), null);
});

test('tool_update folds into the card: clamped, never backwards, elapsed kept', () => {
  const card = { k: 'tool', name: 'video.generate', ok: null };
  M.toolUpdateApply(card, { tool: 'video.generate', fraction: 0, elapsed_ms: 1200, label: 'sent to google/veo-3.1-fast on OpenRouter' }, 10);
  assert.deepEqual(card.progress, { fraction: 0, elapsedMs: 1200, label: 'sent to google/veo-3.1-fast on OpenRouter', at: 10 });
  M.toolUpdateApply(card, { fraction: 0.42, elapsed_ms: 125000, label: 'about 42%' }, 20);
  assert.equal(card.progress.fraction, 0.42);
  M.toolUpdateApply(card, { fraction: 0.3, elapsed_ms: 145000 }, 30);
  assert.equal(card.progress.fraction, 0.42, 'a lower guess does not move the bar back');
  assert.equal(card.progress.elapsedMs, 145000);
  assert.equal(card.progress.label, 'about 42%');
  M.toolUpdateApply(card, { fraction: 7, elapsed_ms: 'x' }, 40);
  assert.equal(card.progress.fraction, 1);
  assert.equal(card.progress.elapsedMs, 145000);
  M.toolUpdateApply(card, { fraction: NaN }, 50);
  assert.equal(card.progress.fraction, 1);
});

test('the running card says how far it got; nothing once it is done', () => {
  assert.equal(M.toolProgressText(null), '');
  assert.equal(M.toolProgressText({ fraction: 0, elapsedMs: 4600 }), 'Sent, waiting for the provider · 5 s');
  assert.equal(M.toolProgressText({ fraction: 0.42, elapsedMs: 125000 }), 'About 42% · 2 min');
  // Done is the card's own state, never "100%" from a guess.
  assert.equal(M.toolProgressText({ fraction: 1, elapsedMs: 60000 }), 'About 99% · 1 min');
  const running = { ok: null, progress: { fraction: 0.5, elapsedMs: 61000 } };
  const html = M.toolProgressHTML(running, (s) => s);
  assert.match(html, /class="cardsum tl-prog"/);
  assert.match(html, /width:50%/);
  assert.match(html, /About 50% · 1 min/);
  assert.equal(M.toolProgressHTML({ ok: true, progress: running.progress }), '');
  assert.equal(M.toolProgressHTML({ ok: null }), '');
});

// ATO-811: a clip playing in a reply stops when its chat leaves the screen and is back paused.
test('leaving the chat pauses a reply clip, and coming back does not start it again', () => {
  const fakeVideo = () => {
    const on = {};
    return {
      paused: true, isConnected: false, parent: null, plays: 0,
      addEventListener(t, f) { (on[t] = on[t] || []).push(f); },
      fire(t) { (on[t] || []).forEach((f) => f()); },
      play() { this.plays++; this.paused = false; this.fire('playing'); return Promise.resolve(); },
      pause() { this.paused = true; this.fire('pause'); },
      cloneNode() { return fakeVideo(); },
    };
  };
  const slot = (path) => ({
    dataset: { chatVid: path },
    appendChild(n) { n.isConnected = true; n.parent = this; },
    contains(n) { return n.parent === this; },
  });
  const root = (slots) => ({
    querySelectorAll(sel) { return sel === '[data-chat-vid]:not([data-hyd])' ? slots.filter((s) => !s.dataset.hyd) : []; },
  });
  const had = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { STUDIO: { mediaUrl: (p) => 'file://' + p } };
  globalThis.document = { createElement: () => fakeVideo() };
  try {
    const path = '/w/ato-811.mp4';
    const st = M.chatVideo(path);
    M.chatVideoHydrate(root([slot(path)]));
    const v = st.node;
    v.play();                                   // the person starts the clip
    assert.equal(st.playing, true);
    M.pauseChatMedia(root([]));                 // another chat or Studio is opened
    assert.equal(v.paused, true, 'the clip stops when its chat leaves the screen');
    assert.equal(st.playing, false);
    v.isConnected = false; v.parent = null;     // the old transcript goes
    v.fire('pause');                            // the browser's own pause for the removal
    M.chatVideoHydrate(root([slot(path)]));     // the chat is back
    assert.equal(v.isConnected, true);
    assert.equal(v.plays, 1, 'the clip does not start by itself on the way back');
    assert.equal(v.paused, true);
  } finally {
    globalThis.window = had.window; globalThis.document = had.document;
  }
});
