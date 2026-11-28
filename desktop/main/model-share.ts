/**
 * ATO-2483: Settings › Models › "Share this model", the pure half. The
 * agent's `GET/POST /api/model-share` answer (src/http/route-model-share.ts)
 * read into what the window draws, and whether it is announced on the
 * network (model-share-announce.ts). The routes are in model-share-ipc.ts.
 */

export type ShareMode = "off" | "local" | "network";

export type ShareListener =
  | { state: "off" }
  | { state: "listening"; host: string; port: number }
  | { state: "main"; port: number; network: boolean }
  | { state: "failed"; host: string; port: number; problem: "port-busy" | "not-allowed" | "failed" };

export interface ShareView {
  mode: ShareMode;
  port: number;
  key: string | null;
  local: string;
  lan: string[];
  listener: ShareListener | null;
}

const MODES: readonly ShareMode[] = ["off", "local", "network"];

export function isShareMode(x: unknown): x is ShareMode {
  return typeof x === "string" && (MODES as readonly string[]).includes(x);
}

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function port(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x > 0 && x <= 65535 ? x : null;
}

function readListener(x: unknown): ShareListener | null {
  const l = obj(x);
  if (!l) return null;
  if (l.state === "off") return { state: "off" };
  const p = port(l.port);
  if (p === null) return null;
  if (l.state === "listening" && typeof l.host === "string") return { state: "listening", host: l.host, port: p };
  if (l.state === "main") return { state: "main", port: p, network: l.network === true };
  if (l.state === "failed" && typeof l.host === "string") {
    const problem = l.problem === "port-busy" || l.problem === "not-allowed" ? l.problem : "failed";
    return { state: "failed", host: l.host, port: p, problem };
  }
  return null;
}

/** The agent's answer as a view, or null when it is not one. */
export function readShareAnswer(data: unknown): ShareView | null {
  const d = obj(data);
  if (!d || !isShareMode(d.mode)) return null;
  const p = port(d.port);
  const urls = obj(d.urls);
  if (p === null || !urls || typeof urls.local !== "string") return null;
  const lan = Array.isArray(urls.lan) ? urls.lan.filter((u): u is string => typeof u === "string" && /^http:\/\//.test(u)) : [];
  return {
    mode: d.mode,
    port: p,
    key: d.mode !== "off" && typeof d.key === "string" && d.key.length > 0 ? d.key : null,
    local: urls.local,
    lan,
    listener: readListener(d.listener),
  };
}

/**
 * The port to announce over mDNS, or null: only while the model is shared
 * on the network and a listener there is actually up. This computer only,
 * off, or a port that failed: nothing is announced.
 */
export function announcePortOf(view: ShareView | null): number | null {
  if (!view || view.mode !== "network" || !view.listener) return null;
  const l = view.listener;
  if (l.state === "listening" && l.host === "0.0.0.0") return l.port;
  if (l.state === "main" && l.network) return l.port;
  return null;
}
