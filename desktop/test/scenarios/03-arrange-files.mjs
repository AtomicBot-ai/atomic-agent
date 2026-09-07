/**
 * 03 — tidy a messy folder.
 *
 * The person: drops a pile of mixed files into the folder the app is open
 * on (the "Downloads folder" job, done a thousand times a day) and asks the
 * agent to sort them into subfolders by type.
 *
 * The human result: every file is still there, each one under the right
 * subfolder, and nothing was invented or destroyed. Losing a file is the
 * failure that matters here, so it is checked by name and by CONTENT — a
 * file the agent re-created empty at the new path is a lost file.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  scenario, main, ask, waitTurn, check, modelDidNot, SCENARIO_NAME,
} from '../harness.mjs';

/** name → [folder it belongs in, its exact contents] */
const PILE = {
  'invoice-2026-03.txt':  ['documents', 'Invoice 0312 — 480.00 EUR — paid 2026-03-14\n'],
  'packing-list.txt':     ['documents', 'tent\nstove\ntwo dry bags\nmap case\n'],
  'ferry-times.csv':      ['data',      'route,departs,arrives\nOban-Craignure,08:00,08:46\nOban-Craignure,11:00,11:46\n'],
  'tide-heights.csv':     ['data',      'time,metres\n06:00,0.9\n12:00,4.1\n18:00,1.0\n'],
  'checksum.json':        ['data',      '{"algorithm":"sha256","files":3}\n'],
  'resize-photos.sh':     ['scripts',   '#!/bin/sh\nfor f in *.jpg; do echo "would resize $f"; done\n'],
  'backup.sh':            ['scripts',   '#!/bin/sh\necho "would back up $HOME/notes"\n'],
};

/** Every file under `root`, as path-relative-to-root → contents. */
function walk(root, base = root, out = {}) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out[relative(base, p)] = readFileSync(p, 'utf8');
  }
  return out;
}

export const run = () => scenario(SCENARIO_NAME(import.meta.url), async ({ app, workspace }) => {
  const messy = join(workspace, 'inbox');
  mkdirSync(messy, { recursive: true });
  for (const [name, [, body]] of Object.entries(PILE)) writeFileSync(join(messy, name), body);
  app.log(`seeded ${Object.keys(PILE).length} loose files in inbox/`);

  await ask(app,
    'The folder "inbox" here is a mess. Please tidy it: move every file into a subfolder of inbox '
    + 'named after what it is — put the .txt files in inbox/documents, the .csv and .json files in '
    + 'inbox/data, and the .sh files in inbox/scripts. Create those three folders. '
    + 'Move the files, do not copy them, do not change what is inside any of them, and do not delete '
    + 'anything. When you are done, tell me how many files ended up in each folder.');

  const turn = await waitTurn(app, { timeout: 420000 });
  app.log(`the agent finished; ${turn.approvals} approval(s) clicked along the way`);

  const after = walk(messy);
  app.log(`inbox now holds: ${Object.keys(after).sort().join(', ')}`);

  // ---- nothing lost --------------------------------------------------------
  const lost = Object.keys(PILE).filter((n) => !Object.keys(after).some((p) => p.endsWith(n)));
  check(lost.length === 0, 'every file survived the tidy-up',
    `missing: ${lost.join(', ')}; what is there: ${Object.keys(after).join(', ')}`);

  // ---- nothing damaged -----------------------------------------------------
  const changed = Object.entries(PILE)
    .map(([n, [, body]]) => [n, Object.entries(after).find(([p]) => p.endsWith(n))])
    .filter(([n, hit]) => hit && hit[1] !== PILE[n][1])
    .map(([n]) => n);
  check(changed.length === 0, 'every file still holds exactly what it held before',
    `altered: ${changed.join(', ')}`);

  // ---- nothing invented ----------------------------------------------------
  const extra = Object.keys(after).filter((p) => !Object.keys(PILE).some((n) => p.endsWith(n)));
  check(extra.length === 0, 'nothing new was left lying around in inbox/',
    `unexpected: ${extra.join(', ')}`);

  // ---- and it is actually sorted ------------------------------------------
  const misfiled = Object.entries(PILE)
    .map(([n, [folder]]) => ({ name: n, want: `${folder}/${n}`, at: Object.keys(after).find((p) => p.endsWith(n)) }))
    .filter((f) => f.at !== f.want);
  if (misfiled.length) {
    const stillLoose = misfiled.some((f) => f.at && !f.at.includes('/'));
    modelDidNot(
      stillLoose ? 'move the files out of inbox/ at all' : 'put every file in the folder that was named',
      misfiled.map((f) => `${f.name}: wanted ${f.want}, is at ${f.at}`).join('; '));
  }
  check(true, 'each file sits in the subfolder that was named for its type');

  check(existsSync(join(messy, 'documents')) && existsSync(join(messy, 'data')) && existsSync(join(messy, 'scripts')),
    'all three subfolders exist');
  check(/\b(2|two)\b|\b(3|three)\b/.test(turn.reply),
    'the agent reports the counts back in the chat',
    JSON.stringify(turn.reply.slice(0, 240)));
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
