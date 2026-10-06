/**
 * ATO-244 — a local model that runs on the processor, said out loud.
 *
 * On a Windows PC with an RTX 3080 Ti the managed llama-server could not
 * load its CUDA build and ran on the CPU instead (the cause is fixed in the
 * agent). Nothing said so: the person watched "Working…" for three and a half
 * minutes on a 2048-token prompt read at 15 tokens a second, gave up and
 * went back to the cloud. llama-server.log knew from its first lines:
 *
 *   warning: no usable GPU found, --gpu-layers option will be ignored
 *
 * The desktop reads that line once the model server is up (daemon-watch.ts,
 * at each start the app makes or finds) and tells the window, which says it
 * once per start above the composer while the route is the local model.
 *
 * The log is appended to across starts, so a line from an earlier run must
 * not speak for this one: every managed launch writes its own
 * `[atomic-agent] launch:` lines before llama.cpp says anything
 * (src/local-llm/daemon-lifecycle.ts), and only what comes after the last of
 * them is read — the rule src/local-llm/server-fault.ts currentRunLog keeps
 * for the agent's own `fault:` line. A log with no launch line at all (an
 * older agent, or a tail that cut the launch off) says nothing here: a notice
 * the person cannot act on is worse than none.
 *
 * On macOS the Metal build never prints the line. A CPU-only build picked on
 * purpose (`localModels.managed.backendVariant: "cpu"`) prints it every
 * time, and the person already knows: that is the caller's to leave out
 * (cpuOnlyWorthSaying).
 */

/** The lines every managed launch writes before the server's own output. */
export const LAUNCH_LINE = "[atomic-agent] launch:";

/** llama.cpp's own words for a server with no GPU to offload to (common/arg.cpp). */
const NO_GPU = /no usable GPU found/i;

/**
 * The lines the current run wrote: everything after the last
 * `[atomic-agent] launch:` line, or null when the log has none.
 */
export function currentRunLines(logText: string): string[] | null {
  const lines = logText.split(/\r?\n/);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trimStart().startsWith(LAUNCH_LINE)) { last = i; break; }
  }
  return last === -1 ? null : lines.slice(last + 1);
}

/** Whether the server the log's last launch started found no GPU and runs on the CPU. */
export function ranOnCpu(logText: string): boolean {
  const run = currentRunLines(logText);
  return !!run && run.some((l) => NO_GPU.test(l));
}

/**
 * Whether a CPU-only run is worth a word to the person: not when the CPU
 * build is what they asked for (`backendVariant: "cpu"`).
 */
export function cpuOnlyWorthSaying(logText: string, backendVariant: unknown): boolean {
  return backendVariant !== "cpu" && ranOnCpu(logText);
}

/**
 * What main tells the window on the `app:daemonWatch` channel, beside the
 * supervisor's own notices. `seq` moves with every start the app makes or
 * finds, so the window says it once per start and a dismissal holds only for
 * the start it was made on.
 */
export interface CpuOnlyNotice {
  kind: "cpu_only";
  cpuOnly: boolean;
  seq: number;
  modelId: string | null;
}

/** The line agent.log and Diagnostics get, at WARN. */
export function cpuOnlyLogLine(modelId: string | null): string {
  return `[desktop] local-llm: the model server found no usable GPU and runs on the CPU${modelId ? ` (model ${modelId})` : ""}; replies will be slow`;
}
