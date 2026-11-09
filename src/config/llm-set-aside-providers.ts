import { emitConfigNoticeOnce } from "./config-primitives.js";

/**
 * ATO-1241 — reading `llm.providers` written by a newer build.
 *
 * The state dir is shared with the desktop app, which can be newer than
 * this build. A provider entry whose `kind` (or `subscriptionCli.cli`)
 * this build does not know is not a broken file: this build cannot run
 * it, so the entry is set aside (left out of the parsed config, one
 * notice) and every reference to it reads as if it were not pinned. A
 * whole-file write puts the entry and the references back
 * (`keepSetAsideConfigValues`). Anything that is not a non-empty string
 * there is left to the strict parser, which still rejects it.
 */
export function setAsideUnknownProviders(
  raw: unknown,
  field: string,
  knownKinds: ReadonlySet<string>,
  knownClis: readonly string[],
): { entries: unknown; setAside: ReadonlySet<string> } {
  const setAside = new Set<string>();
  if (!Array.isArray(raw)) return { entries: raw, setAside };
  const entries = raw.filter((entry, i) => {
    const reason = unknownProviderReason(entry, knownKinds, knownClis);
    if (reason === null) return true;
    const id = (entry as { id: string }).id;
    setAside.add(id);
    emitConfigNoticeOnce(
      `[atomic-agent] ${field}[${i}] ${JSON.stringify(id)} uses ${reason} this build does not know (a newer app may have added it); it is not used here — update atomic-agent to use it`,
    );
    return false;
  });
  return { entries: setAside.size === 0 ? raw : entries, setAside };
}

/** What makes `entry` a newer build's provider, or null when this build can parse (or must reject) it. */
export function unknownProviderReason(
  entry: unknown,
  knownKinds: ReadonlySet<string>,
  knownClis: readonly string[],
): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  if (typeof obj.kind === "string" && obj.kind.length > 0 && !knownKinds.has(obj.kind)) {
    return `kind ${JSON.stringify(obj.kind)}`;
  }
  const cli = (obj.subscriptionCli as { cli?: unknown } | null | undefined)?.cli;
  if (
    obj.subscriptionCli !== null && typeof obj.subscriptionCli === "object" &&
    typeof cli === "string" && cli.length > 0 && !knownClis.includes(cli)
  ) {
    return `subscription CLI ${JSON.stringify(cli)}`;
  }
  return null;
}

/**
 * The `llm` block with every reference to a set-aside provider removed:
 * the fallback chain skips it, a fusion leg pinned to it (and that leg's
 * model label) reads as unpinned, an active embedding provider resolves
 * as if none were named, and an active text provider becomes `standIn`
 * (null when nothing is left to stand in, so the strict check reports
 * the original id).
 */
export function withoutSetAsideProviderRefs(
  obj: Record<string, unknown>,
  setAside: ReadonlySet<string>,
  standIn: string | null,
): Record<string, unknown> {
  if (setAside.size === 0) return obj;
  const out: Record<string, unknown> = { ...obj };
  const named = (v: unknown): boolean => typeof v === "string" && setAside.has(v);
  if (named(out.activeTextProvider) && standIn !== null) out.activeTextProvider = standIn;
  if (named(out.activeEmbeddingProvider)) delete out.activeEmbeddingProvider;
  const fallback = out.fallback as Record<string, unknown> | null | undefined;
  if (fallback && typeof fallback === "object" && Array.isArray(fallback.chain)) {
    out.fallback = { ...fallback, chain: fallback.chain.filter((id) => !named(id)) };
  }
  const runMode = out.runMode as Record<string, unknown> | null | undefined;
  const fusion = runMode && typeof runMode === "object" ? runMode.fusion as Record<string, unknown> | null | undefined : undefined;
  if (runMode && fusion && typeof fusion === "object" && !Array.isArray(fusion)) {
    const next = { ...fusion };
    if (named(next.orchestratorProvider)) { delete next.orchestratorProvider; delete next.orchestratorModel; }
    if (named(next.workerProvider)) { delete next.workerProvider; delete next.workerModel; }
    out.runMode = { ...runMode, fusion: next };
  }
  return out;
}

/** The id an active text provider that was set aside reads as: the default if it is configured, else the first provider. */
export function setAsideActiveStandIn(
  providerIds: readonly string[],
  defaultId: string,
): string | null {
  return providerIds.includes(defaultId) ? defaultId : (providerIds[0] ?? null);
}
