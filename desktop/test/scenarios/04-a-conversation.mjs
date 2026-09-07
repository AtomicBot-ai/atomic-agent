/**
 * 04 — a conversation that continues.
 *
 * The person: asks a question, gets an answer, and then asks a follow-up
 * that is meaningless on its own. "What country is it the capital of?"
 * only has an answer if the app carried the first turn into the second.
 *
 * The human result: the second reply is about the city the FIRST reply
 * chose, and the chat still shows both turns afterwards. Two facts a
 * person could check by scrolling up — no session id, no internal flag.
 *
 * The first question is worded so the answer set is small and checkable:
 * every European capital starting with B, with the country each belongs to.
 */

import {
  scenario, main, ask, waitTurn, check, modelDidNot, SCENARIO_NAME,
} from '../harness.mjs';

const CAPITALS = {
  berlin: 'germany', bern: 'switzerland', berne: 'switzerland',
  bratislava: 'slovakia', brussels: 'belgium', bruxelles: 'belgium',
  bucharest: 'romania', budapest: 'hungary', belgrade: 'serbia',
  baku: 'azerbaijan', 'bosnia': 'bosnia', sarajevo: 'bosnia',
};

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app }) => {
  await ask(app, 'Name exactly one European capital city whose name begins with the letter B. '
    + 'Answer with just the city name and nothing else.');
  const first = (await waitTurn(app, { timeout: 240000 })).reply;
  app.log(`first answer: ${JSON.stringify(first.slice(0, 120))}`);
  check(first.trim().length > 0, 'the agent answered the first question');

  const city = Object.keys(CAPITALS).find((c) => first.toLowerCase().includes(c));
  if (!city) modelDidNot('name a European capital beginning with B', JSON.stringify(first.slice(0, 200)));
  app.log(`it chose: ${city}`);

  // The follow-up names nothing. It only works if the first turn is still there.
  await ask(app, 'What country is it the capital of? Just the country.');
  const second = (await waitTurn(app, { timeout: 240000 })).reply;
  app.log(`follow-up answer: ${JSON.stringify(second.slice(0, 160))}`);

  check(second.trim().length > 0, 'the agent answered the follow-up at all',
    'an empty reply here means the second question never reached the model');
  check(!/which city|what city|refer to|not sure what|clarify|context/i.test(second),
    'it did not ask what "it" meant — the first turn was still in the conversation',
    JSON.stringify(second.slice(0, 240)));
  check(second.toLowerCase().includes(CAPITALS[city]),
    `the follow-up answers about ${city} — the app carried the conversation forward`,
    `expected "${CAPITALS[city]}", got ${JSON.stringify(second.slice(0, 240))}`);

  // And a person can still scroll up and see both exchanges.
  const onScreen = await app.eval(`(() => {
    const t = [...document.querySelectorAll('#content .turn')];
    return { mine: t.filter((n) => n.classList.contains('usr')).map((n) => n.innerText.trim().slice(0, 40)),
             total: t.length };
  })()`);
  app.log(`the chat shows ${onScreen.total} turns; mine: ${JSON.stringify(onScreen.mine)}`);
  check(onScreen.mine.length >= 2, 'both of my questions are still on screen',
    JSON.stringify(onScreen));
  check(onScreen.mine[0].includes('European capital'),
    'the first question is still where I can scroll back to it',
    JSON.stringify(onScreen.mine));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
