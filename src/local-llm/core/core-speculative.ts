/**
 * Which Atomic Core providers can run speculative decoding (ATO-452).
 *
 * Core's load call takes `mtp` and `dflash` switches, but its argument
 * builder clears both for the `llamacpp` provider (the TurboQuant fork
 * that serves chat): `src/runtime/llamacpp/args.ts` in Core 0.18.6 (the
 * version this build pins) and still in 0.24.1, with the comment that
 * the TurboQuant plugin has no speculative decoding. On
 * `llamacpp-upstream` Core emits `--spec-type draft-mtp` for a model
 * with an MTP head, on a llama.cpp build new enough for it. DFlash also
 * needs a separate draft file and a build flag, which we never pass.
 *
 * So today chat can never use it, and `coreLoadOverrides` keeps sending
 * `false`. When Core lifts the block for TurboQuant, flipping the
 * `llamacpp` entry here is the switch; the model check is
 * `hasInlineMtpHead` (`catalog/gguf-speculative.ts`).
 */
export interface CoreSpeculativeSupport {
  /** Core passes MTP flags for a model whose file has an MTP head. */
  mtp: boolean;
  /** Core passes DFlash flags (needs a draft model path). */
  dflash: boolean;
}

const NONE: CoreSpeculativeSupport = { mtp: false, dflash: false };

const BY_PROVIDER: Readonly<Record<string, CoreSpeculativeSupport>> = {
  // Cleared by Core for the TurboQuant fork.
  llamacpp: NONE,
  // Core gates MTP on the installed llama.cpp build itself.
  "llamacpp-upstream": { mtp: true, dflash: false },
};

export function coreSpeculativeSupport(provider: string): CoreSpeculativeSupport {
  return BY_PROVIDER[provider] ?? NONE;
}

/**
 * The `mtp` switch for a Core load: on only when the provider honours it
 * and the model file has an MTP head. Everything else stays off.
 */
export function coreMtpSwitch(provider: string, modelHasMtpHead: boolean): boolean {
  return modelHasMtpHead && coreSpeculativeSupport(provider).mtp;
}
