import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ShowOnceHelper, type ShowOnceHelperChild, type ShowOnceHelperPush } from "./show-once-helper.js";
import { parseShowOnceProbe, runShowOnceProbe, type ShowOnceProbe } from "./show-once-probe.js";

/**
 * ATO-2499 "Show once": who answers "what was under this click / behind
 * this key" for one recording. The Accessibility helper when the build has
 * it and it starts (show-once-helper.ts), otherwise the one-osascript-per-
 * event path from ATO-2401 (show-once-probe.ts). A helper that stops
 * answering mid-recording is asked no more: the rest goes to osascript.
 *
 * Only the osascript path reuses a key's answer for a moment
 * (KEY_PROBE_FRESH_MS): each osascript costs a process, the helper does not.
 * No electron import; `nativeDir` and the runners are passed in.
 */

export const KEY_PROBE_FRESH_MS = 1500;

export interface ShowOnceProber {
  /** "helper" or "osascript", for the log line and the tests. */
  readonly via: "helper" | "osascript";
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
  spawnHelper?: (file: string) => ShowOnceHelperChild;
  osascript?: (kind: "click" | "key", x?: number, y?: number) => Promise<ShowOnceProbe>;
  log?: (line: string) => void;
}

export function showOnceHelperPath(nativeDir: string): string {
  return join(nativeDir, "atomic-show-once");
}

const empty = (): ShowOnceProbe => parseShowOnceProbe({});

export async function openShowOnceProber(deps: ShowOnceProberDeps): Promise<ShowOnceProber> {
  const osascript = deps.osascript ?? runShowOnceProbe;
  let keyProbe: { at: number; probe: ShowOnceProbe } | null = null;
  let helper: ShowOnceHelper | null = null;
  const file = showOnceHelperPath(deps.nativeDir);
  if (deps.platform === "darwin" && (deps.exists ?? existsSync)(file)) {
    const h = new ShowOnceHelper({
      spawn: () => (deps.spawnHelper ?? ((f: string) => spawn(f, [], { stdio: ["pipe", "pipe", "ignore"] }) as unknown as ShowOnceHelperChild))(file),
      onPush: deps.onPush,
    });
    if (await h.start()) helper = h;
    else deps.log?.("[desktop] show once: the Accessibility helper did not start; asking osascript per event");
  } else if (deps.platform === "darwin") {
    deps.log?.("[desktop] show once: this build has no Accessibility helper; asking osascript per event");
  }

  const viaHelper = async (kind: "click" | "key", x = 0, y = 0): Promise<ShowOnceProbe | null> => {
    if (!helper) return null;
    const p = await helper.ask(kind, x, y);
    if (p) return p;
    if (!helper.running) {
      deps.log?.("[desktop] show once: the Accessibility helper stopped; asking osascript for the rest");
      helper = null;
    }
    return null;
  };

  return {
    get via() {
      return helper ? "helper" : "osascript";
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
