import type {
  DetectedLocalServer,
  LocalServerKind,
} from "../../llm/provider/presets/detect-local-servers.js";
import { t } from "../../i18n/index.js";
import { ONBOARDING_CHOICES, type OnboardingUiState } from "./onboarding-state.js";

/**
 * ATO-2013 / ATO-2168: what the first-run choice screen does with local
 * servers already running on this computer (Ollama, LM Studio, the Llama
 * app). The "Custom endpoint" row is where a server you already run goes,
 * so that row names what was found, is the one the cursor starts on, and
 * its Enter goes straight to the found server instead of an empty URL
 * box. Same idea as OpenClaw's onboarding offering the Llama app first,
 * and Continue / Jan picking up a running Ollama.
 */

/** Short names: the detail column is measured, and counts would widen it. */
const SHORT_NAMES: Record<LocalServerKind, string> = {
  "llama-app": "Llama app",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

function found(onboarding: Pick<OnboardingUiState, "detectedLocal">): readonly DetectedLocalServer[] {
  return onboarding.detectedLocal ?? [];
}

/** Row the choice screen's cursor starts on: Custom when something runs here. */
export function chooseCursorFor(onboarding: Pick<OnboardingUiState, "detectedLocal">): number {
  if (found(onboarding).length === 0) return 0;
  const idx = ONBOARDING_CHOICES.findIndex((choice) => choice.id === "custom");
  return idx >= 0 ? idx : 0;
}

/**
 * The Custom row's first detail line: the found servers when there are
 * any, the usual description otherwise.
 */
export function customDetailLine(
  detected: readonly DetectedLocalServer[] | undefined,
  fallback: string,
): string {
  if (!detected || detected.length === 0) return fallback;
  const names = [...new Set(detected.map((server) => SHORT_NAMES[server.kind]))];
  return t("onboarding.choose.custom.found", { servers: names.join(", ") });
}

/**
 * Where Enter on the Custom row goes. llama.cpp (the Llama app,
 * `llama-server`) is this agent's own External route, so it opens the URL
 * step with that address filled in. Ollama and LM Studio are provider
 * presets, so they open the provider list with the found ones on top.
 * `null`: nothing found, the usual empty URL step.
 */
export type CustomBranch =
  | { readonly kind: "llama_url"; readonly url: string }
  | { readonly kind: "provider_list"; readonly detected: readonly DetectedLocalServer[] };

export function customBranchFor(
  onboarding: Pick<OnboardingUiState, "detectedLocal">,
): CustomBranch | null {
  const servers = found(onboarding);
  if (servers.length === 0) return null;
  const llama = servers.find((server) => server.kind === "llama-app");
  if (llama) return { kind: "llama_url", url: llama.baseUrl };
  const presets = servers.filter((server) => server.presetId !== null);
  return presets.length > 0 ? { kind: "provider_list", detected: presets } : null;
}
