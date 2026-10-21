/**
 * Studio: every failure the window sees, as `{code, message, details?}`.
 *
 * `code` is Core's own (atomic-chat-core v0.18.6 src/contracts/errors.ts
 * `DIFFUSION_ERROR_CODES`, plus `INVALID_ARGUMENT` from the generic routes)
 * or one of the desktop's: NO_KEY, CORE_NOT_INSTALLED, CORE_START_FAILED,
 * CORE_UNREACHABLE, CORE_TIMEOUT, CORE_BUSY, CORE_MISMATCH, CORE_INVALID,
 * CORE_LOCK_STALE, OUTSIDE, BAD_ANSWER, JOB_NOT_FOUND, FAILED, and for
 * local models (studio-local-models.ts) DISK_SPACE, UNKNOWN_MODEL,
 * MODEL_NOT_DOWNLOADED, ENGINE_UNSUPPORTED, ENGINE_INSTALL_FAILED,
 * DOWNLOAD_FAILED. `message`
 * is a sentence a person can act on; the wording for Core's codes follows the agent's image tool
 * (src/local-llm/core/core-image.ts `describeCoreImageError`). Pure.
 */

import { StudioCoreError } from "./studio-core-client.js";
import { StudioRequestError } from "./studio-requests.js";

export interface StudioErrorBody { code: string; message: string; details?: string }

export function describeStudioError(code: string, message: string, cloud: boolean): string {
  const why = message.replace(/\.$/, "");
  switch (code) {
    case "NO_KEY":
      return "Add an OpenRouter API key in Settings → Providers to generate in the cloud.";
    case "JOB_BUSY":
      return cloud
        ? "Four cloud generations are already running. Wait for one to finish."
        : "Atomic Core is already generating. Wait for it to finish.";
    case "GPU_BUSY":
      return "The graphics card is busy with another model. Wait for it to finish, or stop the local model.";
    case "MODEL_NOT_LOADED":
      return "No local model is loaded in Atomic Core. Pick a cloud model, or load a local one first.";
    case "ENGINE_MISSING":
      return "The image engine is not installed yet. Try again: it installs before the first local generation.";
    case "MODEL_MISSING":
    case "SIDE_FILE_MISSING":
      // Core names the file: "<name> is missing. Download the model again."
      return message;
    case "OUT_OF_MEMORY":
      return "The model ran out of memory. Try a smaller size or fewer images.";
    case "QUEUE_FULL":
      return "Atomic Core's queue is full. Try again in a moment.";
    case "DISK_FULL":
      return "The disk is full. Free some space or pick another output folder.";
    case "REMOTE_NOT_CONFIGURED":
      return "OpenRouter is not set up in Atomic Core yet. Check that an OpenRouter key is configured.";
    case "REMOTE_AUTH_FAILED":
      return "OpenRouter refused the API key. Check the key in Settings → Providers.";
    case "REMOTE_QUOTA":
      return "OpenRouter says the account is out of credits. Top up at openrouter.ai and try again.";
    case "REMOTE_RATE_LIMITED":
      return "OpenRouter is rate limiting requests. Try again in a minute.";
    case "REMOTE_CONTENT_BLOCKED":
      return `The model refused this prompt or image (${why}). Rephrase it and try again.`;
    case "REMOTE_REJECTED":
    case "REMOTE_UNSUPPORTED":
    case "UNSUPPORTED_WORKFLOW":
      return `The model cannot do that (${why}).`;
    case "REMOTE_TIMEOUT":
      return "The model did not answer in time. Try again.";
    case "REMOTE_UNAVAILABLE":
      return `The cloud provider is unavailable right now (${why}). Try again later.`;
    case "CANCELLED":
      return "Stopped.";
    case "CORE_NOT_INSTALLED":
    case "CORE_START_FAILED":
    case "CORE_UNREACHABLE":
    case "CORE_TIMEOUT":
    case "CORE_BUSY":
    case "CORE_MISMATCH":
    case "CORE_INVALID":
    case "CORE_LOCK_STALE":
    case "OUTSIDE":
    case "INVALID_REQUEST":
    case "INVALID_ARGUMENT":
    case "INVALID_DIMENSIONS":
    case "DISK_SPACE":
    case "UNKNOWN_MODEL":
    case "MODEL_NOT_DOWNLOADED":
    case "ENGINE_UNSUPPORTED":
    case "ENGINE_INSTALL_FAILED":
    case "DOWNLOAD_FAILED":
      return message;
    default:
      return `Generation failed: ${why}.`;
  }
}

/** Any thrown value as the window's error body. */
export function studioErrorBody(err: unknown, cloud = false): StudioErrorBody {
  if (err instanceof StudioRequestError) return { code: err.code, message: err.message };
  if (err instanceof StudioCoreError) {
    return { code: err.code, message: describeStudioError(err.code, err.message, cloud), ...(err.details ? { details: err.details } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "FAILED", message: describeStudioError("FAILED", message, cloud) };
}
