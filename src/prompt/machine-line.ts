/**
 * ATO-1721 / ATO-1706: the `machine:` line of `### capabilities`, e.g.
 * `machine: 16 GB RAM, Intel Core i5-8250U, no GPU, Windows 10`. A small
 * local model asked "what computer is this" answered that it had no
 * access to the hardware; with the facts in the prompt it does not need
 * a tool call for the basics.
 *
 * Only facts that cannot move while the process runs (installed RAM, CPU
 * name, GPU presence, OS name): the line sits in the stable prefix, so a
 * free-memory or free-disk figure would break the KV cache every step.
 * Read once per runtime at bootstrap (`buildCapabilities`) and reused for
 * every session; a failed or slow probe leaves the line out.
 *
 * Only sent for a model served on this machine (`capabilitiesForServedModel`):
 * hardware details stay off cloud providers.
 */

import { readFileSync } from "node:fs";
import { cpus, release } from "node:os";

import {
  probeMachineForModels,
  type ProbeMachineInput,
} from "../local-llm/backend/machine-for-models.js";
import type { MachineForModels } from "../local-llm/catalog/model-upgrade.js";
import type { CapabilitiesSummary } from "./stable-prefix.js";

/** Same ceiling as the `which` probes beside it in `buildCapabilities`. */
export const MACHINE_PROBE_TIMEOUT_MS = 2000;

export interface MachineLineFacts {
  machine: Pick<MachineForModels, "ramGb" | "gpuBudgetGb" | "cpuOnly">;
  platform: NodeJS.Platform;
  /** `os.cpus()[0].model`. */
  cpuModel?: string;
  /** `describeOs`; `null` leaves the OS out. */
  osName: string | null;
}

/** The value after `machine: `. Pure. */
export function formatMachineLine(facts: MachineLineFacts): string {
  const parts = [`${facts.machine.ramGb} GB RAM`];
  const cpu = facts.cpuModel?.replace(/\s+/g, " ").trim();
  if (cpu) parts.push(cpu);
  const gpu = describeGpu(facts.machine, facts.platform, cpu);
  if (gpu) parts.push(gpu);
  if (facts.osName) parts.push(facts.osName);
  return parts.join(", ");
}

function describeGpu(
  machine: MachineLineFacts["machine"],
  platform: NodeJS.Platform,
  cpu: string | undefined,
): string | null {
  // macOS: the probe reports a RAM share, not a card. Apple Silicon has
  // one GPU on the chip; an Intel Mac's GPU is not probed at all.
  if (platform === "darwin") {
    return cpu?.startsWith("Apple") ? "GPU on the chip (shares RAM)" : null;
  }
  if (machine.cpuOnly) return "no GPU";
  if (machine.gpuBudgetGb !== null && machine.gpuBudgetGb > 0) {
    return `GPU with ${Math.round(machine.gpuBudgetGb)} GB memory`;
  }
  // The engine is not installed and the driver did not answer: unknown,
  // not absent, so nothing is claimed.
  return null;
}

/**
 * Human OS name from `os.release()`: Windows 10 / 11 by build number
 * (Windows 11 still reports a "10.0" kernel), macOS by Darwin major,
 * Linux from `/etc/os-release`.
 */
export function describeOs(
  platform: NodeJS.Platform,
  rel: string = release(),
  readOsRelease: () => string = () => readFileSync("/etc/os-release", "utf8"),
): string | null {
  if (platform === "win32") {
    const [major, , build] = rel.split(".").map(Number);
    if (major === 10) return (build ?? 0) >= 22000 ? "Windows 11" : "Windows 10";
    return "Windows";
  }
  if (platform === "darwin") {
    const darwin = Number.parseInt(rel, 10);
    if (!Number.isFinite(darwin)) return "macOS";
    // Darwin 25 is macOS 26 (the year numbering); 20..24 are macOS 11..15.
    if (darwin >= 25) return `macOS ${darwin + 1}`;
    if (darwin >= 20) return `macOS ${darwin - 9}`;
    return "macOS";
  }
  if (platform === "linux") {
    try {
      const pretty = /^PRETTY_NAME=(.*)$/m.exec(readOsRelease())?.[1];
      const name = pretty?.replace(/^["']|["']$/g, "").trim();
      return name ? name : "Linux";
    } catch {
      return "Linux";
    }
  }
  return platform;
}

export interface MachineLineProbeInput extends ProbeMachineInput {
  timeoutMs?: number;
  /** Seams for tests. */
  probe?: typeof probeMachineForModels;
  osName?: string | null;
}

/**
 * Probe once and format. Never throws: a probe that fails or takes longer
 * than `timeoutMs` returns `null`, and the prompt simply has no machine line.
 */
export async function probeMachineLine(
  input: MachineLineProbeInput,
): Promise<string | null> {
  const { timeoutMs = MACHINE_PROBE_TIMEOUT_MS, probe = probeMachineForModels, osName, ...probeInput } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const platform = probeInput.platform ?? process.platform;
    const cpuModel = probeInput.cpuModel ?? cpus()[0]?.model;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    const machine = await Promise.race([
      Promise.resolve().then(() => probe({ ...probeInput, platform, ...(cpuModel ? { cpuModel } : {}) })),
      timeout,
    ]);
    if (!machine) return null;
    return formatMachineLine({
      machine,
      platform,
      ...(cpuModel ? { cpuModel } : {}),
      osName: osName !== undefined ? osName : describeOs(platform),
    });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The capabilities a prompt for this model may carry: the machine line is
 * dropped unless the model is served on this machine.
 */
export function capabilitiesForServedModel(
  caps: CapabilitiesSummary,
  servedOnThisMachine: boolean,
): CapabilitiesSummary {
  if (servedOnThisMachine || !caps.machine) return caps;
  const rest: CapabilitiesSummary = { ...caps };
  delete rest.machine;
  return rest;
}
