import { isKnownLocalModelId, type LocalModelDef, type LocalModelId } from "../local-llm/catalog/models-catalog.js";

/**
 * The draft model a `models pull` fetches after the chat model (ATO-2424),
 * so speculative decoding finds its draft next to it: the catalog's
 * pairing (`draftModelId`), or the catalog model `draftModel` names.
 * Asked for with `--draft`, or implied by `draftModel` other than
 * `"off"`. `null`: nothing to fetch (no pairing, a path draft, already on
 * disk, or speculative decoding off and not asked for).
 *
 * Precedent: LM Studio downloads a draft model as an ordinary model and
 * lists it under the main one's "Speculative Decoding" picker.
 */
export function draftToPullAfter(
  model: Pick<LocalModelDef, "id" | "draftModelId">,
  opts: { draftFlag: boolean; preference: string; isDownloaded: (id: LocalModelId) => boolean },
): LocalModelId | null {
  if (!opts.draftFlag && opts.preference === "off") return null;
  const named =
    opts.preference !== "off" && opts.preference !== "auto" && isKnownLocalModelId(opts.preference)
      ? opts.preference
      : null;
  const id = named ?? model.draftModelId ?? null;
  if (id === null || id === model.id) return null;
  return opts.isDownloaded(id) ? null : id;
}
