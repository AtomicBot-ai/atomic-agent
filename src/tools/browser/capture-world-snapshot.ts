import type { BrowserBackend } from "./browser-backend.js";

export interface CapturedWorldSnapshot {
  kind: "browser";
  digest: string;
  text: string;
}

/**
 * Best-effort ARIA snapshot right after a navigation/search/click, so the
 * step-executor can fold it into `session.worldSnapshot` and the model
 * observes the current page in the next prompt's `### world` section.
 *
 * Swallows snapshot failures on purpose: the mutating tool (navigate,
 * search, …) already succeeded, and we do not want an ARIA timeout to
 * flip the tool status to `error`. Callers just skip the field when
 * `undefined` is returned.
 */
export async function captureWorldSnapshot(
  backend: BrowserBackend,
): Promise<CapturedWorldSnapshot | undefined> {
  try {
    const snap = await backend.snapshot();
    return {
      kind: "browser",
      digest: snap.digest,
      text: snap.text,
    };
  } catch {
    return undefined;
  }
}
