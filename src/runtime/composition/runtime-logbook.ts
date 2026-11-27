import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import { resolveLlmConfig, type ProviderRegistry } from "../../llm/provider/index.js";
import {
  captureLogbookFrame,
  createLogbookSidecar,
  logbookDir,
  pickLocalVisionProvider,
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
 * `null` too when the frontend shows no recording mark
 * (`indicatorVisible` false: `serve`, the desktop's sidecar, one-shot
 * CLI runs); only the TUI top bar shows `● logbook` today, so only a TUI
 * process captures, whatever the settings say.
 */
export function createRuntimeLogbook(args: {
  config: Pick<AtomicAgentConfig, "paths">;
  providerRegistry: Pick<ProviderRegistry, "activeTextProviderId" | "getProvider">;
  logger: StructuredLogger;
  /** Whether this process's frontend shows the recording mark (the TUI chip). */
  indicatorVisible: boolean;
  platform?: NodeJS.Platform;
}): SchedulerSidecar | null {
  if (!args.indicatorVisible) return null;
  if ((args.platform ?? process.platform) !== "darwin") return null;
  const stateDir = args.config.paths.stateDir;
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
  });
  return { tick: (now, signal) => sidecar.tick(now, signal) };
}
