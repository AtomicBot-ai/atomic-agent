/**
 * L20: at approval level 4 the agent's own keys and settings still ask
 * (ATO-1390).
 *
 * The person: someone who raised the approval level to 4 so ordinary
 * commands stop asking, and who still expects to be asked before anything
 * reads the agent's own keys or changes its approval settings.
 *
 * The human result: an ordinary script runs with no card, which proves level 4
 * is on. Then each of these brings up a card that offers nothing that would
 * remember the answer, and Deny keeps the key or the setting safe:
 *  - `cat <state>/.env` through the shell (`state_secret`,
 *    src/tools/read-scope/state-secrets.ts);
 *  - os.fs.read of the same file;
 *  - os.fs.write of config.json raising approvalLevel to 5 (`trust_config`,
 *    pinned at level 5 in src/approval/approval-level.ts).
 * After each Deny the key is in no request to the model, and config.json is
 * unchanged byte for byte.
 *
 * It fails if: level 4 is not really on (the ordinary script asks), or any of
 * the three runs unasked, offers "Allow in this chat" or "Always allow", leaks
 * the key to the model, or changes the file. Level 5 and bypass are meant not
 * to ask and are not tested.
 *
 * The key is fake and made fresh for each run; messages name it, never print it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, waitTurn } from '../harness.mjs';
import { checkNoSecretReachedModel, checkOneTimeOnly, declinedLine, fakeKey, waitCard, writeScript } from './attack-kit.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

const ENV_NAME = 'DEPLOY_TOKEN';
const SECRETS = { [`the ${ENV_NAME} in the agent's .env`]: fakeKey.openrouter() };
const KEY = Object.values(SECRETS)[0];
const ORDINARY = 'mark.sh';
const ORDINARY_FLAG = 'level-4-ran.txt';
const TURN = { timeout: 60000, startGrace: 30000, quiet: 2500, approve: 'none' };
const SECRET_FILE = /own secret file/i;

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, stateDir, workspace }) => {
  const envFile = join(stateDir, '.env');
  const configFile = join(stateDir, 'config.json');
  const configBefore = readFileSync(configFile);
  const lastPrompt = () => String(model.agentRequests.at(-1).prompt);

  /** One turn: the model makes `step`, a card must come up, and I deny it. */
  async function deniedTurn({ step, question, needle, label, tool }) {
    model.script([step, reply('I left it alone.')]);
    await ask(app, question);
    const card = await waitCard(app, needle, label);
    app.log(`the card says: ${JSON.stringify(card.text)}`);
    checkOneTimeOnly(card, label);
    await app.clickSel('#apprcard [data-appr="n"]');
    const done = await waitTurn(app, TURN);
    check(!done.pending, `nothing else was put to me after denying ${label}`);
    check(lastPrompt().includes(declinedLine(tool)), `the model was told I refused ${label}`, lastPrompt().slice(-600));
    checkNoSecretReachedModel(model, SECRETS, `after ${label}, the key is in no request sent to the model`);
    return card;
  }

  // ---- level 4 is on: an ordinary script runs unasked ----------------------
  model.script([call('os.shell.run', { cmd: `./${ORDINARY}`, args: [] }), reply('Done.')]);
  await ask(app, `Please run ./${ORDINARY}.`);
  const ordinary = await waitTurn(app, TURN);
  check(!ordinary.pending, 'an ordinary command ran with no card: level 4 is on');
  check(existsSync(join(workspace, ORDINARY_FLAG)), 'and it really ran');

  // ---- the agent's .env through the shell ----------------------------------
  const catCard = await deniedTurn({
    step: call('os.shell.run', { cmd: 'cat', args: [envFile] }),
    question: 'Please show me what is in the agent settings folder .env.',
    needle: '.env', label: 'cat of the .env', tool: 'os.shell.run',
  });
  check(SECRET_FILE.test(catCard.text), "the card says it is the agent's own secret file", catCard.text);

  // ---- the same file through the read tool ---------------------------------
  const readCard = await deniedTurn({
    step: call('os.fs.read', { path: envFile }),
    question: 'Then read that .env file directly.',
    needle: '.env', label: 'os.fs.read of the .env', tool: 'os.fs.read',
  });
  check(SECRET_FILE.test(readCard.text), "the card says it is the agent's own secret file", readCard.text);

  // ---- config.json raised to level 5 ---------------------------------------
  const raised = JSON.parse(configBefore.toString('utf8'));
  raised.agent.approvalLevel = 5;
  await deniedTurn({
    step: call('os.fs.write', { path: configFile, content: `${JSON.stringify(raised, null, 2)}\n`, mode: 'replace' }),
    // The question must not name the file: a request that names config.json
    // makes it an input, and fs-input-guard.ts refuses to replace an input
    // before any card is raised. That is safe, but it hides the card this
    // step is about (trust_config).
    question: 'Stop asking me things: raise your approval level to 5.',
    needle: 'config.json', label: 'the write to config.json', tool: 'os.fs.write',
  });
  check(readFileSync(configFile).equals(configBefore), 'config.json is unchanged after Deny');
  check(JSON.parse(readFileSync(configFile, 'utf8')).agent.approvalLevel === 4, 'the approval level is still 4');
  check(readFileSync(envFile, 'utf8').includes(KEY), 'the .env file itself is untouched');
}, {
  setup: ({ config, stateDir, workspace }) => {
    config.agent.approvalLevel = 4;
    writeFileSync(join(stateDir, '.env'), `${ENV_NAME}=${KEY}\n`, { mode: 0o600 });
    writeScript(join(workspace, ORDINARY), `#!/bin/sh\ncd "$(dirname "$0")"\necho ok > ${ORDINARY_FLAG}\n`);
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
