/**
 * Settings › Connections › Phone push (ATO-1129). The agent owns the
 * setting: `atag push on|off|test` mints the random ntfy topic, writes
 * `notifications.push` and sends the test ping, exactly as in the
 * terminal, so the desktop never makes up a topic of its own. The state
 * the pane shows is `atag config get notifications.push`.
 *
 * This file is pure: argument building, input checks and output parsing.
 * push-ipc.ts runs the commands. An agent older than the push command
 * answers `unknown command: push`; that becomes `{unsupported: true}` and
 * the pane says "update the agent".
 */

export type PushOp = "on" | "off" | "test" | "newTopic";
const OPS: readonly PushOp[] = ["on", "off", "test", "newTopic"];

/** What the window sent; `null` when it is not an operation this pane makes. */
export function parsePushOp(raw: unknown): PushOp | null {
  return typeof raw === "string" && (OPS as readonly string[]).includes(raw) ? (raw as PushOp) : null;
}

/** The argv for one operation. Always an array, never a shell string. */
export function pushCliArgs(op: PushOp): string[] {
  return op === "newTopic" ? ["push", "on", "--new-topic"] : ["push", op];
}

/** `on`/`off` write config.json and take the config lock; `test` only reads it. */
export function pushOpWritesConfig(op: PushOp): boolean {
  return op !== "test";
}

/** True when the agent does not know `push` yet. */
export function isUnsupportedPushCli(text: string): boolean {
  return /unknown command: push\b/i.test(text);
}

export interface PushState {
  enabled: boolean;
  server: string;
  topic: string | null;
  /** The .env variable holding an optional ntfy access token. */
  tokenEnv: string;
  /** Where the phone subscribes; `null` without a topic. */
  subscribeUrl: string | null;
}

/** `atag config get notifications.push`, as the pane reads it; `null` when it is not that block. */
export function parsePushState(value: unknown): PushState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.enabled !== "boolean" || typeof o.server !== "string") return null;
  const server = o.server.replace(/\/+$/, "");
  const topic = typeof o.topic === "string" && o.topic.trim() ? o.topic.trim() : null;
  const tokenEnv = typeof o.tokenEnv === "string" && o.tokenEnv ? o.tokenEnv : "NTFY_TOKEN";
  return { enabled: o.enabled, server, topic, tokenEnv, subscribeUrl: topic ? `${server}/${topic}` : null };
}

/**
 * The ntfy request for a desktop turn notification: the same JSON the
 * agent's own client sends (src/notifications/ntfy-client.ts), to the
 * server root. The note is the native notification's text, which
 * turn-notify.ts already cleaned and clipped; the body is clipped to 200
 * again here. `null` when push is off or has no topic.
 */
export function turnPushRequest(
  push: PushState,
  note: { title: string; body: string },
  token: string | undefined,
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } | null {
  if (!push.enabled || !push.topic) return null;
  const clip = (s: string, n: number) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s);
  return {
    url: `${push.server}/`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: push.topic,
        title: clip(note.title, 80),
        message: clip(note.body, 200) || "-",
        tags: [/fail/i.test(note.title) ? "x" : "white_check_mark"],
        priority: /fail/i.test(note.title) ? 4 : 3,
      }),
    },
  };
}
