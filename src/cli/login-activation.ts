import { createInterface } from "node:readline/promises";

import { getConfig } from "../config/index.js";
import { setActiveTextProviderInConfig } from "../config/llm-provider-commands.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { isLocalLinkWithoutModel } from "../runtime/local-link-availability.js";

/**
 * After `atag login chatgpt` / `atag login copilot`: make the new provider
 * entry the active one, or ask, or say how to switch. Its own module so
 * login-command.ts and login-copilot.ts both use it without importing
 * each other at runtime (scripts/check-imports.mjs rejects the cycle).
 */

export type Activation = "already-active" | "only-provider" | "has-others";

export interface ActivationDeps {
  /** Whether the entry is active already, the only provider, or one of several. */
  activation?: (id: string) => Activation;
  setActive?: (id: string) => void;
  /** A y/n question in the terminal; absent when there is no terminal. */
  ask?: ((question: string) => Promise<string>) | null;
}

/**
 * Other providers are every entry but this one, except the built-in local
 * model while no model is downloaded for it: a fresh install has that
 * entry, and there is nothing to choose between yet.
 */
export function defaultActivation(id: string): Activation {
  const config = getConfig();
  const llm = resolveLlmConfig(config);
  if (llm.activeTextProvider === id) return "already-active";
  const others = llm.providers.filter((p) => p.id !== id && !isLocalLinkWithoutModel(llm, p.id, config));
  return others.length === 0 ? "only-provider" : "has-others";
}

function terminalAsk(): ((question: string) => Promise<string>) | null {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

export async function offerActivation(
  id: string,
  deps: ActivationDeps,
  write: (t: string) => void,
  serviceName = "ChatGPT",
): Promise<void> {
  const state = (deps.activation ?? defaultActivation)(id);
  if (state === "already-active") return;
  const setActive = deps.setActive ?? setActiveTextProviderInConfig;
  const activate = (): void => {
    try {
      setActive(id);
      write(`"${id}" is now the active provider.\n`);
    } catch {
      write(`Signed in, but "${id}" could not be made active. Pick it in the Providers panel.\n`);
    }
  };
  if (state === "only-provider") {
    activate();
    return;
  }
  const ask = deps.ask === undefined ? terminalAsk() : deps.ask;
  if (ask === null) {
    write(`To use it, pick "${id}" in the Providers panel.\n`);
    return;
  }
  const answer = await ask(`Use ${serviceName} now? [y/N] `);
  if (/^y(es)?$/i.test(answer.trim())) {
    activate();
  } else {
    write(`Kept your current provider. To switch later, pick "${id}" in the Providers panel.\n`);
  }
}
