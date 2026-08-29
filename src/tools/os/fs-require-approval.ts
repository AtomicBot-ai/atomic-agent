import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ApprovalCategory } from "../../approval/approval-level.js";
import {
  categorizeFsMutation,
  type FsMutationKind,
} from "./fs-approval-scope.js";

/**
 * `DangerousToolOptions` plus the injected trust-config surface every
 * filesystem-mutating tool needs. The bootstrap resolves the paths once
 * (`getTrustConfigPaths` in `src/config/config-file.ts`) and passes them
 * through `registerOsTools` into each fs tool factory; the tools never
 * read `getConfig()` themselves. Extraction ignores `trustConfigPaths`
 * but accepts the shape for a uniform factory signature.
 */
export interface FsDangerousToolOptions extends DangerousToolOptions {
  /**
   * Absolute paths of the agent's trust config (`config.json`, `.env`).
   * Undefined / empty disables the trust-config guard. Injected — never
   * derived inside the tools layer.
   */
  trustConfigPaths?: readonly string[];
}

/**
 * Everything a filesystem mutation needs to route itself through the
 * approval gate. Deliberately carries the scope inputs (`workingDir`,
 * `trustConfigPaths`) next to the prompt copy so a call site cannot
 * half-wire the ladder — categorisation and the gate call happen together
 * or not at all.
 */
export interface FsApprovalRequest {
  /**
   * Which mutation this is. Selects the categorisation branch:
   *  - `write` (os.fs.write / edit / patch) → workspace / home / other,
   *    or `trust_config` when a target is the agent's own config / `.env`.
   *  - `trash` (os.fs.trash) → `fs_trash` inside workspace or home,
   *    `trust_config` on a config / `.env` target, else `other`.
   *  - `extract` (os.fs.archive.extract) → `fs_write_home` inside
   *    workspace or home (extraction lands at level 3, not 2), else
   *    `other`. The trust-config guard does not apply — extraction
   *    targets a directory, so `destDir` is passed as the sole path and
   *    `trustConfigPaths` is irrelevant to the outcome.
   */
  kind: FsMutationKind;
  /**
   * Absolute target path(s). For `extract` this is the single `destDir`;
   * for the others it is every file the call would touch. The weakest
   * scope wins, and a single trust-config match makes the whole call
   * `trust_config` (see `categorizeFsMutation`).
   */
  paths: readonly string[];
  sessionId: string;
  tool: string;
  reason: string;
  preview?: string;
  affectedResources?: string[];
  /** Session working directory — the workspace root for scope resolution. */
  workingDir: string;
  /**
   * Absolute paths of the agent's trust surface (`config.json`, `.env`),
   * injected from the bootstrap. Omitted / empty disables the guard;
   * `extract` ignores it. Never re-derived inside the tools layer.
   */
  trustConfigPaths?: readonly string[];
  /**
   * Absolute path the operator may retarget from the prompt. Set only
   * by `os.fs.write`, whose destination is a free choice; an edit or a
   * patch acts on a file the model picked for a reason, so redirecting
   * those would be nonsense rather than a feature.
   */
  redirectablePath?: string;
}

/**
 * What the funnel reports back once a request survives the gate.
 */
export interface FsApprovalOutcome {
  /**
   * The category the operator actually approved. Callers that accept a
   * retarget compare it against the new path's category: an equal rung
   * needs no second prompt, a different one does.
   */
  category: ApprovalCategory;
  /** Raw retarget as typed, when the operator supplied one. */
  pathOverride?: string;
}

/**
 * Single funnel every fs-mutation tool routes its approval through. It
 * categorises the mutation (scope + trust-config guard) and hands the
 * result to the shared `requireApproval`, so the ladder wiring lives in
 * one place: a new mutate-tool calls this and cannot forget the
 * `trust_config` guard or classify against the wrong scope inputs.
 *
 * Categorisation reads the filesystem (realpath / lstat) and there is an
 * await before the tool's actual write, so a TOCTOU window exists in
 * principle (a symlink swapped in between here and the write could
 * redirect it). Not exploitable under the strictly-sequential agent loop
 * — nothing else in the session runs between the two — but a future with
 * intra-turn parallelism must re-categorise (or open with `O_NOFOLLOW` +
 * recheck) right before writing rather than trusting this verdict.
 */
export async function requireFsApproval(
  options: DangerousToolOptions,
  request: FsApprovalRequest,
  signal: AbortSignal,
): Promise<FsApprovalOutcome> {
  const category = await categorizeFsMutation(request.kind, request.paths, {
    workingDir: request.workingDir,
    ...(request.trustConfigPaths !== undefined
      ? { trustConfigPaths: request.trustConfigPaths }
      : {}),
  });
  const outcome = await requireApproval(
    options,
    {
      sessionId: request.sessionId,
      tool: request.tool,
      category,
      reason: request.reason,
      ...(request.preview !== undefined ? { preview: request.preview } : {}),
      ...(request.affectedResources !== undefined
        ? { affectedResources: request.affectedResources }
        : {}),
      ...(request.redirectablePath !== undefined
        ? { redirectablePath: request.redirectablePath }
        : {}),
    },
    signal,
  );
  return {
    category,
    ...(outcome.pathOverride !== undefined
      ? { pathOverride: outcome.pathOverride }
      : {}),
  };
}
