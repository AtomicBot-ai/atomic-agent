/**
 * What a model file carries for speculative decoding (ATO-452).
 *
 * A GGUF converted with its multi-token-prediction (MTP / NextN) layers
 * says so in `<arch>.nextn_predict_layers`: the number of extra layers
 * that draft the next tokens. llama.cpp's `--spec-type draft-mtp` uses
 * them with no separate draft model. This is the same signal Jan reads
 * (`detectMtpLayersFromGgufMeta`) to decide whether to offer its MTP
 * switch.
 *
 * Detection only. Whether the engine can use the head is a separate
 * question (`core-speculative.ts`); nothing here turns anything on.
 */
import type { GgufMetadata } from "./gguf-metadata.js";

/** MTP draft layers built into the file, `0` when it has none. */
export function mtpDraftLayers(meta: Pick<GgufMetadata, "architecture" | "keys">): number {
  if (meta.architecture === "") return 0;
  const value = meta.keys[`${meta.architecture}.nextn_predict_layers`];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return 0;
  return value;
}

/** `true` when the file itself can draft tokens for speculative decoding. */
export function hasInlineMtpHead(meta: Pick<GgufMetadata, "architecture" | "keys">): boolean {
  return mtpDraftLayers(meta) > 0;
}
