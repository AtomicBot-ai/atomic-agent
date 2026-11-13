import type { LlmProvider } from "../llm/index.js";

/**
 * Which provider `vision.describe` talks to, and whether the prompt
 * should offer it at all — both answered from the LIVE route, never
 * from a boot snapshot.
 *
 * The tool used to be built around the provider that was active when
 * the runtime started. An operator who booted on a text-only cloud
 * model and then switched to a local vision model (`/llm provider`,
 * `/model`, the route picker) kept sending images to the boot provider
 * and got its 400 back until a restart. The provider is now looked up
 * per call: the one the step is pinned to (a fusion worker runs on the
 * local leg via `ToolContext.providerId`), else the active text
 * provider — which is the orchestrator's cloud leg in fusion, since the
 * resolver requires the orchestrator to be `llm.activeTextProvider`.
 */
export interface VisionProviderLookup {
  readonly activeText: LlmProvider;
  getProvider(id: string): LlmProvider | undefined;
}

/**
 * The provider serving this step. A pinned id the registry does not
 * hold resolves to `undefined` rather than degrading to the active
 * provider: an image sent on behalf of a fusion worker must never be
 * quietly re-routed to the cloud leg.
 */
export function resolveVisionProvider(
  registry: VisionProviderLookup,
  providerId: string | undefined,
): LlmProvider | undefined {
  if (providerId !== undefined) return registry.getProvider(providerId);
  return registry.activeText;
}

/**
 * Whether a provider can take `vision.describe` as far as the prompt is
 * concerned. A local `llama-server` link counts unless vision is off in
 * config: its `capabilities.vision` follows the live `/props` profile
 * and reads `false` until the first probe lands (a cloud boot defers
 * it), so gating the descriptor on it would drop the tool from the
 * prompt of a session that is about to see images. The tool still
 * re-checks at call time and refuses cleanly when the loaded model has
 * no projector. A cloud link's capability is the answer for the one
 * MODEL it serves (`llm/provider/model-vision.ts`: config, then the
 * catalogue, else offered until the service rejects an image), so a
 * text-only model drops the tool and a vision model brings it back.
 */
export function providerOffersVision(
  provider: LlmProvider,
  isLlamaServer: boolean,
): boolean {
  if (provider.capabilities.vision) return true;
  return isLlamaServer && provider.capabilities.visionSource !== "config-disabled";
}

export interface VisionRouteGateDeps {
  registry: VisionProviderLookup;
  isLlamaServer: (providerId: string) => boolean;
  /** The fusion worker leg while fusion is effective, else `null`. */
  fusionWorkerProviderId: () => string | null;
}

/**
 * The live gate behind `providerAvailable` in the descriptor filter:
 * true when some leg of the current route can see — the active
 * provider, or (in fusion) the worker leg the orchestrator delegates
 * to. Re-evaluated on every descriptor read, so a provider switch
 * shows or hides the tool on the next step.
 */
export function visionRouteAvailable(deps: VisionRouteGateDeps): boolean {
  const active = deps.registry.activeText;
  if (providerOffersVision(active, deps.isLlamaServer(active.id))) return true;
  const workerId = deps.fusionWorkerProviderId();
  if (workerId === null || workerId === active.id) return false;
  const worker = deps.registry.getProvider(workerId);
  return (
    worker !== undefined &&
    providerOffersVision(worker, deps.isLlamaServer(worker.id))
  );
}

/**
 * Whether `audio.listen` is offered on a provider (ATO-497, decision 62).
 * `vision.audioInput` is tri-state:
 *
 * - `false`: never.
 * - `true`: always, cloud included (the operator agreed the file may be
 *   uploaded); a model that cannot hear still refuses per call.
 * - unset (auto, the default): only a LOCAL `llama-server` link whose
 *   loaded model reports audio (`/props` `modalities.audio`, i.e. its
 *   projector has an audio encoder). A local model without audio, and
 *   every cloud model, leave the tool out, so audio stays a file for
 *   the `audio-transcribe` skill. Unlike vision there is no "offered
 *   before the probe lands": the descriptor appears once `/props` says
 *   the model can hear.
 */
export function providerOffersAudio(
  provider: LlmProvider,
  isLlamaServer: boolean,
  audioInput: boolean | undefined,
): boolean {
  if (audioInput === false) return false;
  if (audioInput === true) return true;
  return isLlamaServer && provider.capabilities.audio === true;
}

/**
 * Whether audio may be sent to this provider at call time. Same rule as
 * the descriptor gate minus the capability (the tool checks that
 * itself, with a better refusal): in auto mode a cloud provider never
 * receives the file, even when a model on it could hear.
 */
export function audioInputAllowedOn(
  isLlamaServer: boolean,
  audioInput: boolean | undefined,
): boolean {
  if (audioInput === false) return false;
  return audioInput === true || isLlamaServer;
}

export interface AudioRouteGateDeps extends VisionRouteGateDeps {
  /** Live `vision.audioInput`: `true`, `false` or unset (auto). */
  audioInput: () => boolean | undefined;
}

/**
 * The live gate behind the `audio` descriptor filter: true when the
 * active provider, or the fusion worker leg, offers audio under
 * `providerOffersAudio`. Re-read on every descriptor read, so a local
 * model swap to (or away from) an audio-capable model shows or hides
 * the tool on the next step.
 */
export function audioRouteAvailable(deps: AudioRouteGateDeps): boolean {
  const setting = deps.audioInput();
  if (setting === false) return false;
  const active = deps.registry.activeText;
  if (providerOffersAudio(active, deps.isLlamaServer(active.id), setting)) return true;
  const workerId = deps.fusionWorkerProviderId();
  if (workerId === null || workerId === active.id) return false;
  const worker = deps.registry.getProvider(workerId);
  return (
    worker !== undefined &&
    providerOffersAudio(worker, deps.isLlamaServer(worker.id), setting)
  );
}
