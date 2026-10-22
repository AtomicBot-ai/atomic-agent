/**
 * ATO-813: the Hugging Face token as the agent itself would send it.
 *
 * The agent reads `HF_TOKEN`, then `HUGGING_FACE_HUB_TOKEN`
 * (src/local-llm/catalog/huggingface-api.ts huggingFaceToken), after
 * load-dotenv.ts has applied `<stateDir>/.env` to every name the environment
 * leaves unset or empty. huggingface.ts's port reads this app's environment
 * only, so a token kept where the agent keeps keys was invisible to Studio and
 * a gated model (Krea 2) failed to download. This reads both, in the agent's
 * order. The value is only ever put in an Authorization header: never logged,
 * never sent to the window.
 */

import { readDotenvValue } from "./composio-key.js";

/** One name as the agent sees it: a non-empty environment value wins, else the `.env` one. */
function asAgentSees(name: string, stateDir: string, env: NodeJS.ProcessEnv): string {
  const own = env[name];
  if (own !== undefined && own.length > 0) return own;
  return readDotenvValue(stateDir, name) ?? "";
}

export function agentHuggingFaceToken(stateDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (asAgentSees("HF_TOKEN", stateDir, env) || asAgentSees("HUGGING_FACE_HUB_TOKEN", stateDir, env)).trim();
  return raw.length > 0 ? raw : null;
}
