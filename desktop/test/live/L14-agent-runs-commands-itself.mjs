/**
 * L14: the agent runs the steps of a task itself, and hands over only the
 * step that needs a person (PR #954 / #973, ATO-1252).
 *
 * The person: someone who asks the agent to install and start things, and who
 * should only be asked for what only they can do.
 *
 * The human result: a tool found only in a user toolchain folder runs, with the
 * installer switches set. A command stuck at a password is stopped promptly and
 * only that step is handed over. A sign-in stays alive as a job, finishes after
 * the person signs in, and is collected. A dev server keeps running after the
 * turn ends until it is told to stop.
 *
 * A scripted model cannot show that a real model chooses to run things, so the
 * model half is one check: the instruction is in the real prompt. The rest is
 * what the shell tool changes on the machine.
 *
 * It fails if: the toolchain PATH or the switches are gone (the tool is not found,
 * or `installed.txt` has empty values); the prompt watch is gone (the password
 * command sits until the timeout and the process is alive); a sign-in is killed
 * rather than kept; `background: true` blocks or dies with the turn; or the
 * "needs the user" line stops reaching the model.
 *
 * Every fixture stops by itself after three minutes, so a failed run cannot
 * leave one running for long.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { call, reply } from './scripted-model.mjs';

/* A folder withToolchainEnv adds (src/sandbox/command-toolchain-env.ts) and the
   desktop's own PATH fix does not (desktop/main/installer-path.ts). */
const TOOL = 'fixture-tool';
const SIGN_IN_URL = 'https://example.test/login/device';
const SIGN_IN_CODE = 'ABCD-1234';
/* The one phrase the full and the compact persona share (src/prompt/stable-prefix.ts). */
const RUN_IT_YOURSELF = 'yourself with `os.shell.run`';
const SWITCHES = { npm_config_yes: 'true', GIT_TERMINAL_PROMPT: '0', PIP_NO_INPUT: '1', DEBIAN_FRONTEND: 'noninteractive' };
const TURN = { timeout: 100000, startGrace: 30000, quiet: 4000, approve: 'auto' };
const UNASKED = { ...TURN, approve: 'none' };

const SCRIPTS = {
  'needs-password.sh': `#!/bin/sh
echo $$ > password.pid
printf 'Password: '
sleep 180
echo finished > password-done.txt
`,
  'sign-in.sh': `#!/bin/sh
echo $$ > signin.pid
echo 'To sign in, open ${SIGN_IN_URL} and enter the one-time code ${SIGN_IN_CODE}'
i=0
while [ ! -f signed-in.flag ] && [ $i -lt 180 ]; do sleep 1; i=$((i+1)); done
[ -f signed-in.flag ] || exit 1
echo ok > signin-done.txt
echo 'sign-in finished here'
`,
  'dev-server.sh': `#!/bin/sh
echo $$ > server.pid
echo 'dev server listening'
i=0
while [ $i -lt 180 ]; do date +%s >> server.beat; sleep 1; i=$((i+1)); done
`,
};

const toolScript = `#!/bin/sh
{ ${Object.keys(SWITCHES).map((k) => `echo "${k}=$${k}"`).join('; ')}; } > installed.txt
echo '${TOOL} installed'
`;

function executable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function untilGone(pid, ms = 20000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await sleep(200);
  return !alive(pid);
}

const lastMatch = (text, re) => [...text.matchAll(re)].at(-1);

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, workspace }) => {
  const at = (name) => join(workspace, name);
  const pidOf = (name) => Number(readFileSync(at(name), 'utf8').trim());
  const lastPrompt = () => String(model.agentRequests.at(-1).prompt);

  // ---- a step the agent runs, then one only a person can do -----------------
  model.script([
    call('os.shell.run', { cmd: TOOL, args: [] }),
    call('os.shell.run', { cmd: './needs-password.sh', args: [] }),
    reply('The tool is installed. The password step is yours.'),
  ]);
  await ask(app, 'Please install the tool and run the setup script.');
  const setup = await waitTurn(app, TURN);
  check(setup.approvals === 2, 'each command went through a card I answered', `${setup.approvals} approvals`);

  check(String(model.agentRequests[0].prompt).includes(RUN_IT_YOURSELF), 'the model is told to run task steps itself');
  check(existsSync(at('installed.txt')), 'the tool in my toolchain folder was found and ran',
    `the prompt ended with: ${lastPrompt().slice(-500)}`);
  const seen = readFileSync(at('installed.txt'), 'utf8');
  for (const [name, value] of Object.entries(SWITCHES)) {
    check(seen.includes(`${name}=${value}\n`), `the command ran with ${name}=${value}`, seen);
  }

  const passwordPid = pidOf('password.pid');
  check(await untilGone(passwordPid), 'the command stuck at a password was stopped, not left waiting');
  check(!existsSync(at('password-done.txt')), 'it was stopped before its sleep ran out');
  const handOver = lastPrompt();
  check(handOver.includes('this step needs the user: it asks for a password'), 'the model is told this step needs me', handOver.slice(-700));
  check(handOver.includes('hand the user only this one step'), 'the model is told to hand over only that step', handOver.slice(-700));

  // ---- a sign-in stays alive for the person to finish -----------------------
  model.script([
    call('os.shell.run', { cmd: './sign-in.sh', args: [] }),
    reply('Please finish the sign-in in your browser.'),
  ]);
  await ask(app, 'Please sign the tool in.');
  const signIn = await waitTurn(app, TURN);
  check(signIn.approvals === 1, 'the sign-in command went through a card I answered', `${signIn.approvals} approvals`);

  const told = lastPrompt();
  check(told.includes('this step needs the user: it needs you to sign in'), 'the model is told the sign-in needs me', told.slice(-700));
  check(told.includes(`link: ${SIGN_IN_URL}`) && told.includes(`code: ${SIGN_IN_CODE}`), 'the model has the link and the code to give me', told.slice(-700));
  const keptJob = lastMatch(told, /still waiting as job (\d+) \(kept\)/);
  check(!!keptJob, 'the sign-in is kept as a job', told.slice(-700));
  const signInPid = pidOf('signin.pid');
  await sleep(1500);
  check(alive(signInPid), 'the sign-in is still running after the turn ended');
  check(!existsSync(at('signin-done.txt')), 'the sign-in has not finished before I signed in');

  writeFileSync(at('signed-in.flag'), 'ok\n'); // the person finishing in their browser

  model.script([
    call('os.shell.run', { wait: Number(keptJob[1]), timeoutMs: 20000 }),
    reply('Signed in.'),
  ]);
  await ask(app, 'I have signed in.');
  const collected = await waitTurn(app, UNASKED);
  check(!collected.pending, 'waiting on my own job does not ask me again');
  check(existsSync(at('signin-done.txt')), 'the kept command went on and finished after I signed in');
  check(await untilGone(signInPid), 'the sign-in command has ended');
  check(lastPrompt().includes('sign-in finished here'), "the model got the finished command's output", lastPrompt().slice(-500));

  // ---- a server keeps running after the turn --------------------------------
  model.script([
    call('os.shell.run', { cmd: './dev-server.sh', args: [], background: true }),
    reply('The dev server is running.'),
  ]);
  await ask(app, 'Please start the dev server.');
  const started = await waitTurn(app, TURN);
  check(started.approvals === 1, 'starting the server went through a card I answered', `${started.approvals} approvals`);

  const running = lastMatch(lastPrompt(), /still running \(job (\d+), pid/);
  check(!!running, 'the server came back as a running job', lastPrompt().slice(-700));
  const serverPid = pidOf('server.pid');
  const beats = () => readFileSync(at('server.beat'), 'utf8').split('\n').length;
  const beatsBefore = beats();
  await sleep(3500);
  check(alive(serverPid), 'the server is still running after the turn ended');
  check(beats() > beatsBefore, 'the server is still doing work after the turn ended', `${beatsBefore} beats, then ${beats()}`);

  model.script([
    call('os.shell.run', { kill: Number(running[1]) }),
    reply('Stopped.'),
  ]);
  await ask(app, 'Please stop the dev server.');
  const stopped = await waitTurn(app, UNASKED);
  check(!stopped.pending, 'stopping my own job does not ask me again');
  check(await untilGone(serverPid), 'the server process is gone');
  check(/killed \(job \d+, on request\)/.test(lastPrompt()), 'the model was told the server stopped', lastPrompt().slice(-500));
}, {
  setup: ({ workspace, home }) => {
    const bin = join(home, '.cargo', 'bin');
    mkdirSync(bin, { recursive: true });
    executable(join(bin, TOOL), toolScript);
    for (const [name, body] of Object.entries(SCRIPTS)) executable(join(workspace, name), body);
    /* A value the operator already exported would win over the agent's own. */
    return Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, undefined]));
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
