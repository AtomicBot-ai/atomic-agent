import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runSlashCommand } from "../submit-handler.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState } from "../tui-state.js";
import { SLASH_COMMANDS } from "./slash-commands.js";

/**
 * Guard for the dead-dispatch class of bug: a slash command that emits
 * an action only an orchestrator on the event bus handles. Dispatch
 * feeds the React reducer only (the bus → reducer bridge is one-way),
 * so such an action is silently dropped — `/llm provider <id>` opened
 * the LLM tab and switched nothing. Every bus-handled action a slash
 * command produces has to be routed to its orchestrator through a
 * callback in `submit-handler.ts` instead of being dispatched.
 */

const TUI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(path);
  }
  return out;
}

/**
 * Action types matched inside `…subscribe(<listener>)` bodies — the
 * requests orchestrators act on when they arrive over the bus.
 */
function busHandledActionTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of sourceFiles(TUI_DIR)) {
    const src = readFileSync(file, "utf8");
    let from = 0;
    for (;;) {
      const at = src.indexOf(".subscribe(", from);
      if (at < 0) break;
      let depth = 0;
      let end = at + ".subscribe".length;
      for (; end < src.length; end += 1) {
        const ch = src[end];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = src.slice(at, end);
      for (const m of body.matchAll(
        /(?:type\s*===\s*|case\s+)"([a-z0-9_]+)"/g,
      )) {
        types.add(m[1]!);
      }
      from = end;
    }
  }
  return types;
}

/**
 * Requests with no bus listener at all: the orchestrator method is
 * reachable only through its callback, so dispatching one is just as
 * dead. The scan cannot see these, so they are named here.
 */
const CALLBACK_ONLY_TYPES: readonly string[] = [
  "providers_contract_probe_requested",
  "providers_inline_models_ensure_requested",
  "local_models_daemon_restart_requested",
];

/**
 * Every registered command bare, plus the argument shapes the handler
 * branches on. Add a line here when a command grows a new verb.
 */
const SLASH_INPUTS: readonly string[] = [
  ...SLASH_COMMANDS.flatMap((cmd) => [
    `/${cmd.name}`,
    ...(cmd.aliases ?? []).map((alias) => `/${alias}`),
  ]),
  "/llm provider local-llama",
  "/llm provider aimlapi",
  "/llm fallback",
  "/llm check",
  "/llm restart",
  "/model pull qwen-3.5-4b",
  "/model use qwen-3.5-4b",
  "/model status",
  "/model http://127.0.0.1:8080",
  "/mcp add",
  "/mcp remove demo",
  "/memory dump",
  "/skills dump",
  "/skills browse",
  "/skills search git",
  "/skills install owner/repo",
  "/skill enable demo",
  "/skill disable demo",
  "/task new",
  "/task cancel t1",
  "/task run t1",
  "/telegram enable",
  "/telegram token",
  "/telegram pair",
  "/privacy analytics on",
  "/analytics status",
  "/queue clear",
  "/queue mode",
  "/queue hello",
  "/steer hello",
  "/mode auto",
  "/theme list",
  "/mouse on",
  "/runmode status",
  "/tools file",
];

function allCallbacks(): TuiAppCallbacks {
  // Every callback exists and does nothing: the guard is about what
  // reaches `dispatch`, not about what the callbacks do.
  return new Proxy({} as TuiAppCallbacks, {
    get: () => vi.fn(),
  });
}

describe("slash commands never dispatch a bus-only action", () => {
  const busTypes = new Set([
    ...busHandledActionTypes(),
    ...CALLBACK_ONLY_TYPES,
  ]);

  it("finds the orchestrator bus handlers it is guarding", () => {
    // If the scan stops matching, the guard below passes vacuously.
    expect(busTypes).toContain("providers_set_active_text");
    expect(busTypes).toContain("providers_refresh_requested");
    expect(busTypes).toContain("memory_refresh_requested");
    expect(busTypes).toContain("mcp_refresh_requested");
  });

  it.each(SLASH_INPUTS)("%s", (input) => {
    const dispatched: TuiAction[] = [];
    runSlashCommand(
      input,
      createInitialTuiState({
        sessionId: "s1",
        workingDir: "/tmp",
        llamaUrl: "http://127.0.0.1:8080",
        browserChannel: "chrome",
        browserHeadless: false,
        approvalLevel: 5,
        maxSteps: 10,
        completionMaxTokens: 2048,
        skillCount: 0,
      }),
      (action) => dispatched.push(action),
      allCallbacks(),
    );
    const dead = dispatched
      .map((action) => action.type)
      .filter((type) => busTypes.has(type));
    expect(dead).toEqual([]);
  });
});
