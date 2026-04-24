/**
 * State slice for the "Local LLM logs" tab. Backed by tail reads of
 * `<dataDir>/llama-server.log`. Kept separate from the Models panel
 * state because the log tail re-renders on a different cadence (1s
 * polling, only when the tab is active) and we don't want snapshots of
 * the model list to churn the log region or vice versa.
 */
export interface LocalLlmLogsState {
  /** Full text of the last tail read (not line-split to preserve colour codes). */
  text: string;
  /** Absolute path to the log file — shown in the panel header. */
  path: string | null;
  /** `stat().size` from the last successful read; used to decide whether to re-render. */
  size: number | null;
  /** True if the tail was clipped from the front because the log grew past `maxBytes`. */
  truncated: boolean;
  /** Wall-clock ms of the last successful read (null until first read). */
  lastReadAt: number | null;
  /** Sticky message from the last failed read (missing file, permission error). */
  error: string | null;
}

export function createInitialLocalLlmLogsState(): LocalLlmLogsState {
  return {
    text: "",
    path: null,
    size: null,
    truncated: false,
    lastReadAt: null,
    error: null,
  };
}
