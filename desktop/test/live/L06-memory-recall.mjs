/**
 * L06: what the agent saved comes back in a new chat and after a restart.
 *
 * The person: someone who told the agent something worth keeping, opens a new
 * chat later, then quits the app and comes back the next day.
 * The human result: the agent knows it, with no embedding model installed.
 *
 * It fails if `memory.profile.set` or `memory.notes.store` do not persist, if
 * a new chat's prompt lacks the saved profile fact or the matching note, if
 * the facts do not survive an app restart on the same state folder, or if the
 * real `memory.notes.recall` tool does not return the note.
 *
 * The saved words appear only in the scripted tool arguments and never in
 * anything the person types, so the only way they can reach a later prompt is
 * through the memory store.
 *
 * `setup` turns on just the three features this needs. Embeddings stay off,
 * which is the keyword path real no-embedding users get. The query rewriter
 * is switched off too: it is a model sub-call, and this tier's stand-in would
 * answer it with filler that could replace the search words.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from '../drive.mjs';
import { SCENARIO_NAME, ask, check, main, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const PROFILE_KEY = 'home_harbour';
const PROFILE_VALUE = 'Kestrel Quay 4417';
const NOTE_WORDS = 'marigold tin 9023';
const NOTE = `The spare boathouse key is hidden behind the ${NOTE_WORDS}.`;
const FIRST_CHAT_MARK = 'bilge-weather-remark';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500 };

/** The new turn's requests, once `runTurn` has finished. */
async function turnRequests(model, runTurn) {
  const before = model.agentRequests.length;
  const done = await runTurn();
  return { done, requests: model.agentRequests.slice(before) };
}

async function newChat(app) {
  await app.clickSel('#sidebar .sb-new[data-act="session:new"]');
  await app.waitFor(`document.querySelectorAll('#content .turn').length === 0`, 'a new, empty chat', { timeout: 15000 });
}

/** The window after a relaunch, up to the point a message can be sent. */
async function waitWindowReady(app) {
  await app.waitFor(`!!document.querySelector('#entry')`, 'the composer', { timeout: 90000 });
  await app.waitFor(`!!document.querySelector('.cmodechip[data-id]:not([data-id=""])')`, 'the Mode chip', { timeout: 90000 });
  await app.waitFor(`!document.querySelector('.sendbtn[disabled]')`, 'the send button live', { timeout: 60000 });
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base }) => {
  // ---- the first chat saves two things through the real tools ---------------
  model.script([
    call('memory.profile.set', { key: PROFILE_KEY, value: PROFILE_VALUE }),
    call('memory.notes.store', { content: NOTE }),
    reply('Saved.'),
  ]);
  const saving = await turnRequests(model, async () => {
    await ask(app, `Please keep what matters about the boat for later. ${FIRST_CHAT_MARK}`);
    return waitTurn(app, TURN);
  });
  check(saving.done.reply === 'Saved.', 'the first chat finished', JSON.stringify(saving.done.reply.slice(0, 200)));
  check(saving.requests.length === 3, 'the model was asked once per step', `${saving.requests.length} requests`);
  const blank = String(saving.requests[0].prompt);
  check(!blank.includes(PROFILE_VALUE) && !blank.includes(NOTE_WORDS), 'nothing was known before it was saved');

  // ---- a new chat has it, by way of memory and not the old conversation -----
  await newChat(app);
  model.script([reply('It is behind the tin.')]);
  const recalled = await turnRequests(model, async () => {
    await ask(app, 'Where did I leave the spare boathouse key?');
    return waitTurn(app, TURN);
  });
  const newChatPrompt = String(recalled.requests[0].prompt);
  check(!newChatPrompt.includes(FIRST_CHAT_MARK), 'the new chat does not carry the old conversation',
    'the first chat\'s words are in this prompt, so finding the fact here would prove nothing');
  check(newChatPrompt.includes('### profile') && newChatPrompt.includes(PROFILE_VALUE),
    'a new chat is told the saved profile fact', `the prompt ended with: ${newChatPrompt.slice(-800)}`);
  check(newChatPrompt.includes('### recalled') && newChatPrompt.includes(NOTE_WORDS),
    'a new chat is handed the matching note, with no embedding model', `the prompt ended with: ${newChatPrompt.slice(-800)}`);

  // ---- quit the app and come back on the same state folder ------------------
  await app.close();
  const again = await launch(app.opts);
  try {
    await waitWindowReady(again);
    await newChat(again);
    model.script([call('memory.notes.recall', { query: 'boathouse key' }), reply('Found it again.')]);
    const afterRestart = await turnRequests(model, async () => {
      await ask(again, 'Could you look through memories for me?');
      return waitTurn(again, TURN);
    });
    const [asked, afterTool] = afterRestart.requests;
    check(afterRestart.done.reply === 'Found it again.', 'the chat after the restart finished',
      JSON.stringify(afterRestart.done.reply.slice(0, 200)));
    check(String(asked.prompt).includes(PROFILE_VALUE), 'after a restart, a new chat is still told the profile fact',
      `the prompt ended with: ${String(asked.prompt).slice(-800)}`);
    check(!String(asked.prompt).includes(NOTE_WORDS), 'this question shares no word with the note, so it was not injected',
      'the recall check below would prove nothing if the note were already here');
    check(!!afterTool && String(afterTool.prompt).includes(NOTE_WORDS), 'after a restart, the real recall tool returns the note',
      `the follow-up prompt ended with: ${String(afterTool?.prompt).slice(-800)}`);
  } catch (e) {
    try { await again.screenshot(join(base, 'failure-after-restart.png')); } catch { /* the window may be gone */ }
    writeFileSync(join(base, 'app-output-after-restart.log'), again.output());
    throw e;
  } finally {
    await again.close();
  }
}, {
  setup: ({ config }) => {
    config.memory.profile.enabled = true;
    config.memory.notes.enabled = true;
    config.memory.recallInjection.enabled = true;
    config.memory.retrieve.rewriter.enabled = false;
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
