/**
 * ATO-2737: what bare `atag launch` (no agent named) does.
 *
 * Before, it printed "missing agent name" plus the whole help and exited
 * 2. Now it lists the coding CLIs it can start, each marked installed or
 * not, the way `ollama launch` with no integration opens a picker. In a
 * terminal the person picks one by number or name; without one (a script,
 * a pipe) the list is printed with the command to run and nothing starts.
 */

import { createInterface } from "node:readline/promises";

import { LAUNCH_INTEGRATIONS, type LaunchIntegration } from "./launch-integrations.js";

export interface LaunchChoice {
  readonly integration: LaunchIntegration;
  readonly installed: boolean;
}

/** Every integration with whether its binary is on PATH now. */
export function launchChoices(findBinary: (binary: string) => string | null): LaunchChoice[] {
  return LAUNCH_INTEGRATIONS.map((integration) => ({
    integration,
    installed: findBinary(integration.binary) !== null,
  }));
}

/** The numbered list, one CLI per line. */
export function formatLaunchChoices(choices: readonly LaunchChoice[]): string {
  const idWidth = Math.max(...choices.map((c) => c.integration.id.length));
  const nameWidth = Math.max(...choices.map((c) => c.integration.displayName.length));
  const lines = choices.map((c, index) => {
    const state = c.installed ? "installed" : `not installed (${c.integration.installHint})`;
    return `  ${index + 1}. ${c.integration.id.padEnd(idWidth)}  ${c.integration.displayName.padEnd(nameWidth)}  ${state}`;
  });
  return `Coding CLIs atag launch can start:\n${lines.join("\n")}\n`;
}

/**
 * The CLI an answer names: its number in the list, its id or an alias.
 * `null` for an empty answer (nothing picked), `"invalid"` for anything else.
 */
export function readLaunchPick(
  answer: string,
  choices: readonly LaunchChoice[],
): LaunchIntegration | null | "invalid" {
  const text = answer.trim().toLowerCase();
  if (text === "") return null;
  if (/^\d+$/.test(text)) {
    const choice = choices[Number(text) - 1];
    return choice ? choice.integration : "invalid";
  }
  const named = choices.find((c) => c.integration.id === text || c.integration.aliases.includes(text));
  return named ? named.integration : "invalid";
}

export interface LaunchPickDeps {
  readonly isTTY?: () => boolean;
  readonly ask?: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

export type LaunchPickResult =
  | { readonly kind: "picked"; readonly integration: LaunchIntegration }
  /** Exit code to return: the list was shown and nothing starts. */
  | { readonly kind: "done"; readonly code: number };

/** Show the list; in a terminal, ask which CLI to start. */
export async function pickLaunchIntegration(
  choices: readonly LaunchChoice[],
  deps: LaunchPickDeps,
): Promise<LaunchPickResult> {
  const isTTY = deps.isTTY ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  deps.write(formatLaunchChoices(choices));
  if (!isTTY()) {
    deps.write("Start one with: atag launch <name>, e.g. atag launch claude\n");
    return { kind: "done", code: 0 };
  }
  const answer = await (deps.ask ?? defaultAsk)(`Which one? [1-${choices.length} or a name, Enter to cancel] `);
  const pick = readLaunchPick(answer, choices);
  if (pick === null) {
    deps.writeErr("launch: nothing started\n");
    return { kind: "done", code: 0 };
  }
  if (pick === "invalid") {
    deps.writeErr(`launch: "${answer.trim()}" is not in the list\n`);
    return { kind: "done", code: 2 };
  }
  return { kind: "picked", integration: pick };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    // Ctrl+D or Ctrl+C at the prompt: nothing picked.
    return "";
  } finally {
    rl.close();
  }
}
