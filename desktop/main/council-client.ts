/**
 * ATO-2432: the model council's request to the agent (`POST /api/council`)
 * and the reading of its SSE stream. No Electron here, so the Node checks
 * load it (test/council-view.test.mjs); main/council-ipc.ts wires it.
 *
 * The stream is `forecast`, `progress`..., then one `result` or `error`
 * frame. Each frame is handed to `onFrame` as it lands (the window shows the
 * stage), and the call resolves with the last one. An agent from before
 * the route answers 404 "No route for": `supported: false`, so the window
 * can say to update instead of showing an error.
 */

/** The agent's limit on a council question (src/runtime/council-service.ts). */
export const COUNCIL_MAX_CHARS = 4000;

export interface CouncilPayload {
  question: string;
  models?: string;
  judge?: string;
  chairman?: string | null;
  rank?: boolean;
  maxUsd?: number;
  dryRun?: boolean;
}

export type CouncilOutcome =
  | { ok: true; supported: true; report?: unknown; costLine?: string; skipped?: string[] }
  | { ok: false; supported: boolean; error: string; costLine?: string };

export interface CouncilFrame {
  event: string;
  data: Record<string, unknown>;
}

/** The checked request from the window, or why it cannot be sent. */
export function councilRequest(payload: unknown): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const question = typeof p.question === "string" ? p.question.trim() : "";
  if (!question) return { ok: false, error: "Nothing to ask" };
  if (question.length > COUNCIL_MAX_CHARS) return { ok: false, error: `too long (over ${COUNCIL_MAX_CHARS} characters)` };
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const models = text(p.models);
  const judge = text(p.judge);
  const chairman = p.chairman === null ? null : text(p.chairman);
  const maxUsd = typeof p.maxUsd === "number" && Number.isFinite(p.maxUsd) && p.maxUsd >= 0 ? p.maxUsd : undefined;
  return {
    ok: true,
    body: {
      question,
      ...(models ? { models } : {}),
      ...(judge ? { judge } : {}),
      ...(chairman === null ? { chairman: null } : chairman ? { chairman } : {}),
      ...(p.rank === false ? { rank: false } : {}),
      ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}),
      ...(p.dryRun === true ? { dry_run: true } : {}),
    },
  };
}

/**
 * Split SSE text into whole frames; the unfinished tail is returned to be
 * prefixed to the next chunk. Comment lines (`: keepalive`) are skipped.
 */
export function splitSseFrames(buffer: string): { frames: CouncilFrame[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: CouncilFrame[] = [];
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      const parsed = JSON.parse(data.join("\n")) as unknown;
      if (parsed && typeof parsed === "object") frames.push({ event, data: parsed as Record<string, unknown> });
    } catch {
      /* a malformed frame is skipped */
    }
  }
  return { frames, rest };
}

/** The outcome a finished stream's last frame says. */
export function councilOutcomeOf(last: CouncilFrame | null): CouncilOutcome {
  if (last?.event === "result") {
    const d = last.data;
    return {
      ok: true,
      supported: true,
      report: d.report,
      ...(typeof d.cost_line === "string" ? { costLine: d.cost_line } : {}),
      ...(Array.isArray(d.skipped) ? { skipped: d.skipped.filter((s): s is string => typeof s === "string") } : {}),
    };
  }
  if (last?.event === "error") {
    const message = typeof last.data.message === "string" ? last.data.message : "the council failed";
    return { ok: false, supported: true, error: message };
  }
  return { ok: false, supported: true, error: "the agent stopped before the council finished" };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one council on the agent. Never throws; a stop through `signal` resolves `cancelled`. */
export async function runCouncilRequest(
  target: () => { base: string; headers: Record<string, string> },
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; onFrame?: (frame: CouncilFrame) => void; fetchImpl?: typeof fetch } = {},
): Promise<CouncilOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const { base, headers } = target();
    const res = await doFetch(`${base}/api/council`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      const text = await res.text();
      if (res.status === 404 && /No route for/.test(text)) {
        return { ok: false, supported: false, error: "This agent has no model council" };
      }
      type JsonReply = { cost_line?: unknown; refused?: unknown; error?: { message?: unknown } };
      let parsed: JsonReply | null = null;
      try { parsed = JSON.parse(text) as JsonReply; } catch { /* not JSON */ }
      if (res.ok && typeof parsed?.cost_line === "string") {
        // A dry run: the forecast only.
        return typeof parsed.refused === "string"
          ? { ok: false, supported: true, error: parsed.refused, costLine: parsed.cost_line }
          : { ok: true, supported: true, costLine: parsed.cost_line };
      }
      const message = typeof parsed?.error?.message === "string" ? parsed.error.message : `the agent answered ${res.status}`;
      return { ok: false, supported: true, error: message };
    }
    if (!res.body) return { ok: false, supported: true, error: "the agent sent no answer" };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last: CouncilFrame | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseFrames(buffer);
      buffer = split.rest;
      for (const frame of split.frames) {
        last = frame;
        options.onFrame?.(frame);
      }
    }
    return councilOutcomeOf(last);
  } catch (err) {
    if (options.signal?.aborted) return { ok: false, supported: true, error: "cancelled" };
    return { ok: false, supported: true, error: errorText(err) };
  }
}
