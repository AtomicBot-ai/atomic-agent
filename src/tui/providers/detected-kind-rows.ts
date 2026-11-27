import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import { findProviderPreset } from "./provider-presets.js";
import type { WizardKindOption } from "./providers-wizard-phases.js";

/**
 * ATO-2013 / ATO-2168: a local server found running on this computer
 * (Ollama, LM Studio) is lifted to the top of the provider list as the
 * recommended row, with what it serves in the label, the way Continue,
 * Open WebUI and Jan put a running Ollama first. Its ordinary row further
 * down goes away, so the list never shows the same service twice.
 *
 * Pure: the render and the key bindings both call it with the wizard's
 * own `detectedLocal`, so the highlighted row and the row Enter picks are
 * always the same one.
 */
export function orderKindOptionsForDetected(
  options: readonly WizardKindOption[],
  detected: readonly DetectedLocalServer[] | undefined,
): readonly WizardKindOption[] {
  if (!detected || detected.length === 0) return options;
  const lifted: WizardKindOption[] = [];
  const liftedIds = new Set<string>();
  for (const server of detected) {
    const presetId = server.presetId;
    if (presetId === null || liftedIds.has(presetId)) continue;
    const preset = findProviderPreset(presetId);
    if (!preset) continue;
    const row = options.find(
      (option) => typeof option.row === "object" && option.row.presetId === presetId,
    );
    if (!row) continue;
    liftedIds.add(presetId);
    lifted.push({ row: row.row, id: row.id, label: detectedRowLabel(preset.label, server) });
  }
  if (lifted.length === 0) return options;
  const rest = options.filter(
    (option) => !(typeof option.row === "object" && liftedIds.has(option.row.presetId)),
  );
  return [...lifted, ...rest];
}

/** `Ollama (local) · running here: 3 models, 1 loaded`. */
export function detectedRowLabel(presetLabel: string, server: DetectedLocalServer): string {
  const n = server.models.length;
  const parts = [n === 1 ? "1 model" : `${n} models`];
  if (server.loaded.length > 0) parts.push(`${server.loaded.length} loaded`);
  return `${presetLabel} · running here: ${parts.join(", ")}`;
}
