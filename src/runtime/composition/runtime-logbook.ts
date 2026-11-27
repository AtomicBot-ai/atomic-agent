import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import { resolveLlmConfig, type ProviderRegistry } from "../../llm/provider/index.js";
import {
  captureLogbookFrame,
  createLogbookSidecar,
  indicatorState,
  logbookDir,
  pickLocalVisionProvider,
  readLogbookIndicator,
} from "../../logbook/index.js";
import type { SchedulerSidecar } from "../../scheduler/index.js";
import { resolveScreenDeps } from "../../tools/os/screen/screen-host.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * The logbook (ATO-2363) as a scheduler sidecar, so it runs only in the
 * process that leads the scheduler. Always built on macOS: whether it
 * captures is read from `<stateDir>/logbook/settings.json` on every
 * tick (off by default), and the provider is looked up per frame from
 * the live config, local entries only. `null` elsewhere: there is no
 * front-app check to skip protected windows on Windows and Linux yet.
 * Who may capture is `indicator` (ATO-2534):
 * - `"tui"`: the TUI's top bar always shows `● logbook`, so it captures;
 * - `"frontend"`: a process another app drives (the desktop's `serve`)
 *   captures only while that app reports its own mark on screen through
 *   `POST /api/logbook/indicator` (`logbook-indicator.ts`); a process no
 *   frontend reports for (a one-shot CLI run) never captures;
 * - `"none"`: no sidecar at all.
 */
export type LogbookIndicatorSource = "tui" | "frontend" | "none";

export function createRuntimeLogbook(args: {
  config: Pick<AtomicAgentConfig, "paths">;
  providerRegistry: Pick<ProviderRegistry, "activeTextProviderId" | "getProvider">;
  logger: StructuredLogger;
  /** How this process learns that its frontend shows the recording mark. */
  indicator: LogbookIndicatorSource;
  platform?: NodeJS.Platform;
  /** This process's pid, which the frontend's report must name (test seam). */
  pid?: number;
}): SchedulerSidecar | null {
  if (args.indicator === "none") return null;
  if ((args.platform ?? process.platform) !== "darwin") return null;
  const stateDir = args.config.paths.stateDir;
  const pid = args.pid ?? process.pid;
  const framesDir = join(logbookDir(stateDir), "frames");
  const screen = resolveScreenDeps();
  const sidecar = createLogbookSidecar({
    stateDir,
    resolveProvider: () => {
      const live = getConfig();
      return pickLocalVisionProvider({
        entries: resolveLlmConfig(live).providers,
        activeId: args.providerRegistry.activeTextProviderId,
        getProvider: (id) => args.providerRegistry.getProvider(id),
        localModelsUrl: live.localModels.url,
      });
    },
    capture: (provider, excludeApps, signal) =>
      captureLogbookFrame(
        {
          screen,
          framesDir,
          readFile: async (path) => new Uint8Array(await readFile(path)),
          removeFile: (path) => rm(path, { force: true }),
          workingDir: stateDir,
        },
        provider,
        excludeApps,
        signal,
      ),
    sweepFrames: () => rm(framesDir, { recursive: true, force: true }),
    logger: args.logger,
    ...(args.indicator === "frontend"
      ? { indicator: (now: number) => indicatorState(readLogbookIndicator(stateDir), pid, now) }
      : {}),
  });
  return { tick: (now, signal) => sidecar.tick(now, signal) };
}
