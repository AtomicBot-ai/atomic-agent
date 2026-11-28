/**
 * ATO-2501: the "Read scans, photos and audio" calls of My files, beside
 * `my-files.ts` the way `renderer/my-files-ocr.js` sits beside the screen.
 * The status fields it adds (`ocrPages`, `skippedReasons`) are read in
 * `parseStatus`; this module holds the retry call.
 */

import {
  MY_FILES_PATHS,
  MY_FILES_TEXT,
  REMOTE,
  call,
  failed,
  interpretFailure,
  parseJson,
  type MyFilesEnv,
  type MyFilesResult,
} from "./my-files.js";

export function interpretRetry(status: number, text: string): MyFilesResult<{ requeued: number }> {
  if (status < 200 || status >= 300) return interpretFailure(status, text);
  const requeued = (parseJson(text) as { requeued?: unknown } | null | undefined)?.requeued;
  return typeof requeued === "number" && Number.isFinite(requeued) && requeued >= 0
    ? { ok: true, requeued: Math.floor(requeued) }
    : { ok: false, reason: "error", error: MY_FILES_TEXT.badReply, status };
}

/**
 * Read again the skipped scans, photos and audio, after the setting was
 * turned on. Refused on a remote agent like add and remove: its files and
 * its models are on the other computer.
 */
export async function retrySkipped(env: MyFilesEnv) {
  if (env.isRemote()) return REMOTE;
  const r = await call(env, "POST", MY_FILES_PATHS.retry, {});
  return failed(r) ? r : interpretRetry(r.status, r.text);
}
