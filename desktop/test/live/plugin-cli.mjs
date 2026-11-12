/**
 * plugin-cli.mjs: the real `atag plugin ...` for the plugin attack scenarios
 * (L21, L22), run against a scenario's throwaway state folder. The same
 * environment L07 gives the CLI: nothing secret, nothing pointing at real
 * data. The file name does not start with L, so run-all.mjs skips it.
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO_DIR } from '../drive.mjs';

const run_ = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');

const STRIP = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ATOMIC_|^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$|^CI$|^CI_|^CONTINUOUS_INTEGRATION$/i;
function cliEnv({ stateDir, home }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, HOME: home, ATOMIC_AGENT_STATE_DIR: stateDir, ATOMIC_AGENT_ANALYTICS: 'off', DO_NOT_TRACK: '1',
    ATOMIC_AGENT_GRAMMARS_DIR: join(REPO_DIR, 'grammars'), ATOMIC_AGENT_BROWSER_ENABLED: 'false',
    ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES: '0', ATOMIC_AGENT_LLAMA_HEALTH_RETRIES: '0' };
}

/**
 * Run the CLI with no terminal attached (stdin is not a TTY), so nobody can be
 * asked a question. Never throws on a non-zero exit: returns
 * `{ code, stdout, stderr }`, so a scenario can expect a refusal.
 */
export async function atag(dirs, args) {
  try {
    const { stdout, stderr } = await run_(process.execPath, [AGENT_ENTRY, ...args],
      { cwd: dirs.workspace, env: cliEnv(dirs), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (typeof e.code !== 'number') throw e;
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Copy a fixture plugin out of the repo, as a person's own folder would be. */
export function copyFixturePlugin(name, into) {
  const dest = join(into, name);
  cpSync(join(HERE, 'fixtures', 'plugins', name), dest, { recursive: true });
  return dest;
}

export const pluginsFile = (stateDir) => join(stateDir, 'plugins', 'plugins.json');
export const installedDir = (stateDir, name) => join(stateDir, 'plugins', 'installed', name);
/** The plugin's record in plugins.json, or undefined. */
export function pluginRecord(stateDir, name) {
  const file = pluginsFile(stateDir);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')).plugins?.[name];
}
