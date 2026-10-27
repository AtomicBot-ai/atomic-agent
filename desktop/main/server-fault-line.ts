/**
 * The one line that says why the local model server failed, picked out of
 * text the server or the agent wrote: the server's log (daemon-watch
 * describeFault, for the watchdog's notices and ATO-278's `reason`), or a
 * failed start's stderr (analytics/classify backendFailReason).
 *
 * Pure: no fs, no Electron — the unit tests drive it straight.
 */

/** The marker every managed launch writes before llama.cpp says anything (src/local-llm/server/server-fault.ts LAUNCH_MARKER). */
const LAUNCH_MARKER = "[atomic-agent] launch:";

/** A line that names a failure; anything else (a backend note, a loaded library, a progress line) is never picked. */
const FAULT_RE =
  /out of memory|failed to (load|allocate|initiali[sz]e)|error loading model|couldn'?t bind|address already in use|abort|segmentation fault|library not loaded|cannot open shared object/i;

/**
 * The log from its last launch marker on. The log is appended across runs,
 * so without this a fault from an earlier run is told against this one.
 * Text with no marker is returned whole: an external server's log, or the
 * end of a long run's log read from its tail (all of which is then this
 * run's — a marker of a later run would be in it).
 */
export function currentRunText(logText: string): string {
  const at = logText.lastIndexOf(LAUNCH_MARKER);
  return at === -1 ? logText : logText.slice(at);
}

/** The last line naming a failure among the text's last 80 lines, cut to 160 characters, or null. */
export function faultLineIn(text: unknown): string | null {
  if (typeof text !== "string" || !text) return null;
  const lines = text.slice(-16_384).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-80);
  const hit = [...lines].reverse().find((l) => FAULT_RE.test(l));
  return hit ? (hit.length > 160 ? `${hit.slice(0, 157)}…` : hit) : null;
}

/** The server log's failure line for the current run only, or null. */
export function describeFaultIn(logText: string): string | null {
  return faultLineIn(currentRunText(logText));
}
