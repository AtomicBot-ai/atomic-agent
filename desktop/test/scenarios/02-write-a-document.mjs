/**
 * 02 — write a short document.
 *
 * The person: asks for a markdown briefing on a named topic, at a named
 * path, with a couple of things it must cover.
 *
 * The human result: the file is where they asked for it, it is a real
 * document rather than a stub, it is markdown (a title and headings), and
 * it actually covers what was asked. The last part is graded the way a
 * person grades it — by reading for the things they asked about.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  scenario, main, ask, waitTurn, check, modelDidNot, SCENARIO_NAME,
} from '../harness.mjs';

/* Deliberately not a topic a model can waffle about: each of these words
   has to appear because the subject demands it, not because the prompt
   was echoed back. */
const MUST_COVER = ['tide', 'wind', 'fog'];

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  const doc = join(workspace, 'notes', 'kayak-safety.md');

  await ask(app,
    'Write me a short markdown briefing for a friend who is going sea kayaking for the first time. '
    + 'Save it as notes/kayak-safety.md here — create the notes folder if it is missing. '
    + 'Give it a top-level "# " title and at least two "## " sections, and make sure it covers '
    + 'tides, wind and fog, with a sentence or two of real advice on each. '
    + 'Around 200 to 400 words. Then tell me it is saved.');

  const turn = await waitTurn(app, { timeout: 420000 });
  app.log(`the agent finished; ${turn.approvals} approval(s) clicked along the way`);

  if (!existsSync(doc)) {
    modelDidNot('save notes/kayak-safety.md',
      `the workspace holds: ${readdirSync(workspace).join(', ') || '(nothing)'}`);
  }
  check(true, 'notes/kayak-safety.md is exactly where it was asked for');

  const text = readFileSync(doc, 'utf8');
  const words = text.split(/\s+/).filter(Boolean).length;
  app.log(`the document is ${words} words, ${text.split('\n').length} lines`);

  check(words >= 120, 'the document is a real briefing, not a stub',
    `only ${words} words: ${JSON.stringify(text.slice(0, 200))}`);
  check(/^\s*#\s+\S/m.test(text), 'it opens with a markdown title',
    JSON.stringify(text.slice(0, 120)));
  check((text.match(/^\s*##\s+\S/gm) || []).length >= 2,
    'it has at least two sections, as asked',
    `headings found: ${JSON.stringify(text.match(/^#{1,3}\s+.*$/gm) || [])}`);

  const lower = text.toLowerCase();
  const missing = MUST_COVER.filter((w) => !lower.includes(w));
  if (missing.length) {
    modelDidNot(`cover ${missing.join(', ')} — the app saved the file it was given`,
      `the document mentions: ${MUST_COVER.filter((w) => lower.includes(w)).join(', ') || 'none of them'}`);
  }
  check(true, `it covers ${MUST_COVER.join(', ')} — the three things asked for`);

  check(/saved|notes\/kayak-safety\.md|kayak-safety/i.test(turn.reply),
    'the agent says in the chat where it put the file',
    JSON.stringify(turn.reply.slice(0, 220)));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
