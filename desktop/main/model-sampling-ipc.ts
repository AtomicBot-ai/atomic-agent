/**
 * ATO-2482: the routes behind Settings › Models › Sampling
 * (renderer/model-sampling.js; model-sampling.ts has the contract).
 *
 *   modelSampling:get  (id)       what the model runs with: `models sampling <id> --json`
 *   modelSampling:set  (id, set)  the person's whole set (`--set <json>`), or
 *                                 `null` back to the model's default (`--reset`)
 *
 * Writes go through the app's config lock, as every other config write
 * does, so they never interleave with a whole-file write of the window.
 * Under a remote agent the models are on the other computer; the agent
 * call answers that itself (agent-cli.ts remoteModelsCall).
 */

import { ipcMain } from "electron";

import { atagRun, withConfigLock } from "./agent-cli.js";
import { samplingAnswerFrom, samplingArgs, type SamplingAnswer } from "./model-sampling.js";

const READ_MS = 20_000;
const WRITE_MS = 30_000;

export function wireModelSamplingIpc(): void {
  ipcMain.handle("modelSampling:get", async (_e, id: unknown): Promise<SamplingAnswer> => {
    const args = typeof id === "string" ? samplingArgs(id) : null;
    if (!args) return { ok: false, error: "Not a model id." };
    return samplingAnswerFrom(await atagRun(args, READ_MS));
  });
  ipcMain.handle("modelSampling:set", async (_e, id: unknown, set: unknown): Promise<SamplingAnswer> => {
    const value = set === null ? null : set && typeof set === "object" && !Array.isArray(set) ? (set as Record<string, unknown>) : undefined;
    const args = typeof id === "string" && value !== undefined ? samplingArgs(id, value) : null;
    if (!args) return { ok: false, error: "Nothing to save." };
    return samplingAnswerFrom(await withConfigLock(() => atagRun(args, WRITE_MS)));
  });
}
