import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ToolContext } from "../../tool-registry.js";
import { recordOwnWrite } from "../fs/fs-read-freshness.js";
import { RESTORE_MAX_BYTES } from "../fs/fs-restore-store.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "../fs/fs-require-approval.js";

/**
 * The one way an office tool puts bytes on disk: through the same
 * approval funnel as `os.fs.write` (workspace / home / other, and the
 * agent's own config refused below full trust), the previous version of
 * a user's file saved for `os.fs.restore`, and the new file written to a
 * temporary name beside it and renamed into place, so a crash never
 * leaves half a zip where a document was.
 */

export interface OfficeCommit {
  tool: string;
  absolute: string;
  /** The path as the call spelled it, for the restore hint. */
  display: string;
  data: Buffer;
  /** One line for the approval card: what changes. */
  reason: string;
  preview: string;
  /** A whole-file replacement (create with overwrite): the same-turn denial rule applies. */
  replacesWhole: boolean;
}

export interface OfficeCommitResult {
  existed: boolean;
  /** A sentence about the previous version, or null for a new file. */
  restoreNote: string | null;
}

export async function readExisting(absolute: string, tool: string): Promise<Buffer | null> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`${tool}: ${absolute} is not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return readFile(absolute);
}

export async function commitOfficeFile(
  options: FsDangerousToolOptions,
  ctx: ToolContext,
  commit: OfficeCommit,
): Promise<OfficeCommitResult> {
  await requireFsApproval(
    options,
    {
      kind: "write",
      paths: [commit.absolute],
      sessionId: ctx.sessionId,
      tool: commit.tool,
      reason: commit.reason,
      preview: commit.preview,
      affectedResources: [commit.absolute],
      targetPaths: commit.replacesWhole ? [commit.absolute] : [],
      workingDir: ctx.workingDir,
      trustConfigPaths: options.trustConfigPaths,
    },
    ctx.signal,
  );
  // Read after the prompt: the file may have changed while it was open.
  const prior = await readExisting(commit.absolute, commit.tool);
  const restoreNote =
    prior === null ? null : await savePrevious(options, ctx, commit, prior);
  await mkdir(dirname(commit.absolute), { recursive: true });
  const temp = join(
    dirname(commit.absolute),
    `.${basename(commit.absolute)}.atomic-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await writeFile(temp, commit.data);
    await rename(temp, commit.absolute);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
  await recordOwnWrite(ctx.fileVersions, commit.absolute);
  if (prior === null && options.restore !== undefined) {
    // Best effort: a missed record only means a later replace saves a copy it need not.
    await options.restore.recordCreated(ctx.sessionId, commit.absolute).catch(() => undefined);
  }
  return { existed: prior !== null, restoreNote };
}

async function savePrevious(
  options: FsDangerousToolOptions,
  ctx: ToolContext,
  commit: OfficeCommit,
  prior: Buffer,
): Promise<string | null> {
  const store = options.restore;
  if (store === undefined) return null;
  try {
    if (await store.wasCreated(ctx.sessionId, commit.absolute)) return null;
    if (prior.byteLength > RESTORE_MAX_BYTES) {
      return "the previous version was too large to save for os.fs.restore";
    }
    await store.saveCopy(ctx.workingDir, commit.absolute, prior, {
      tool: commit.tool,
      lines: 0,
      sessionId: ctx.sessionId,
    });
    return `the previous version is saved — \`os.fs.restore ${JSON.stringify({ path: commit.display })}\` brings it back`;
  } catch (err) {
    return `the previous version could not be saved: ${(err as Error).message}`;
  }
}

/**
 * `null` and `""` count as absent: a strict native-tools provider sends
 * every unused optional field, as null or as an empty string.
 */
export function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function optionalString(raw: unknown, field: string, tool: string): string | undefined {
  if (!given(raw)) return undefined;
  if (typeof raw !== "string") throw new Error(`${tool}: \`${field}\` must be a string`);
  return raw;
}
