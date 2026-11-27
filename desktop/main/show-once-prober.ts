import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ShowOnceHelper, type ShowOnceHelperChild, type ShowOnceHelperPush } from "./show-once-helper.js";
import { runShowOnceLinuxProbe } from "./show-once-linux.js";
import { parseShowOnceProbe, runShowOnceProbe, type ShowOnceProbe } from "./show-once-probe.js";
import { showOnceWinArgs, showOnceWinShell } from "./show-once-win.js";

/**
 * ATO-2499 "Show once": who answers "what was under this click / behind
 * this key" for one recording. The Accessibility helper when the build has
 * it and it starts (show-once-helper.ts), otherwise the one-osascript-per-
 * event path from ATO-2401 (show-once-probe.ts). A helper that stops
 * answering mid-recording is asked no more: the rest goes to osascript.
 *
 * Only the osascript path reuses a key's answer for a moment
 * (KEY_PROBE_FRESH_MS): each osascript costs a process, the helper does not.
 * ATO-2499 Windows: the resident process is Windows PowerShell running
 * show-once-win.ts, on the same line protocol (it takes longer to start:
 * it compiles its user32 bindings). Linux: xdotool once per event
 * (show-once-linux.ts), in the osascript path's place.
 *
 * No electron import; `nativeDir` and the runners are passed in.
 */

export const KEY_PROBE_FRESH_MS = 1500;

export interface ShowOnceProber {
  /** Who answers: the resident helper, or osascript / xdotool per event ("none" on Windows without PowerShell). */
  readonly via: "helper" | "osascript" | "xdotool" | "none";
  click(x: number, y: number): Promise<ShowOnceProbe>;
  key(at: number): Promise<ShowOnceProbe>;
  /** The focus may have moved (a click, tab or return): the next key asks again. */
  forgetKey(): void;
  stop(): void;
}

export interface ShowOnceProberDeps {
  /** Where the helper binary lives: Resources/native packaged, out/native in a dev run. */
  nativeDir: string;
  platform: NodeJS.Platform | string;
  onPush: (push: ShowOnceHelperPush) => void;
  exists?: (path: string) => boolean;
  spawnHelper?: (file: string, args: string[]) => ShowOnceHelperChild;
  /** The per-event fallback: osascript on the Mac, xdotool on Linux; none on Windows. */
  osascript?: (kind: "click" | "key", x?: number, y?: number) => Promise<ShowOnceProbe>;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export function showOnceHelperPath(nativeDir: string): string {
  return join(nativeDir, "atomic-show-once");
}

const empty = (): ShowOnceProbe => parseShowOnceProbe({});

/** The resident process for this system, or null (Linux, or nothing to run). */
function residentPlan(deps: ShowOnceProberDeps): { file: string; args: string[]; readyMs?: number; answerMs?: number } | null {
  if (deps.platform === "darwin") return { file: showOnceHelperPath(deps.nativeDir), args: [] };
  if (deps.platform === "win32") return { file: showOnceWinShell(deps.env ?? process.env), args: showOnceWinArgs(), readyMs: 15000, answerMs: 2500 };
  return null;
}

/** Who answers when the resident process does not. */
function perEventFallback(deps: ShowOnceProberDeps): { via: "osascript" | "xdotool" | "none"; run: (kind: "click" | "key", x?: number, y?: number) => Promise<ShowOnceProbe> } {
  if (deps.osascript) return { via: deps.platform === "linux" ? "xdotool" : "osascript", run: deps.osascript };
  if (deps.platform === "darwin") return { via: "osascript", run: runShowOnceProbe };
  if (deps.platform === "linux") return { via: "xdotool", run: () => runShowOnceLinuxProbe() };
  return { via: "none", run: () => Promise.resolve(empty()) };
}

export async function openShowOnceProber(deps: ShowOnceProberDeps): Promise<ShowOnceProber> {
  const fallback = perEventFallback(deps);
  const osascript = fallback.run;
  let keyProbe: { at: number; probe: ShowOnceProbe } | null = null;
  let helper: ShowOnceHelper | null = null;
  const plan = residentPlan(deps);
  if (plan && (deps.exists ?? existsSync)(plan.file)) {
    const h = new ShowOnceHelper({
      spawn: () => (deps.spawnHelper ?? ((f: string, a: string[]) => spawn(f, a, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }) as unknown as ShowOnceHelperChild))(plan.file, plan.args),
      onPush: deps.onPush,
      readyMs: plan.readyMs,
      answerMs: plan.answerMs,
    });
    if (await h.start()) helper = h;
    else deps.log?.(`[desktop] show once: the ${deps.platform === "win32" ? "PowerShell" : "Accessibility"} helper did not start; asking ${fallback.via} per event`);
  } else if (plan) {
    deps.log?.(`[desktop] show once: no ${deps.platform === "win32" ? "Windows PowerShell" : "Accessibility helper"} here; asking ${fallback.via} per event`);
  }

  const viaHelper = async (kind: "click" | "key", x = 0, y = 0): Promise<ShowOnceProbe | null> => {
    if (!helper) return null;
    const p = await helper.ask(kind, x, y);
    if (p) return p;
    if (!helper.running) {
      deps.log?.(`[desktop] show once: the helper stopped; asking ${fallback.via} for the rest`);
      helper = null;
    }
    return null;
  };

  return {
    get via() {
      return helper ? "helper" : fallback.via;
    },
    async click(x, y) {
      keyProbe = null;
      return (await viaHelper("click", x, y)) ?? (await osascript("click", x, y).catch(empty));
    },
    async key(at) {
      const fromHelper = await viaHelper("key");
      if (fromHelper) return fromHelper;
      if (!keyProbe || at - keyProbe.at > KEY_PROBE_FRESH_MS) keyProbe = { at, probe: await osascript("key").catch(empty) };
      return keyProbe.probe;
    },
    forgetKey() {
      keyProbe = null;
    },
    stop() {
      keyProbe = null;
      helper?.stop();
      helper = null;
    },
  };
}
