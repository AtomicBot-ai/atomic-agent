/**
 * ATO-1156 — "Continue from Claude Code / Codex".
 *
 * When Claude Code or Codex stops mid-task (its usage limit, say), the
 * person picks one of its fresh sessions here and the work continues in a
 * new Atomic Agent chat. All the reading and saving is the agent's own
 * `atag handoff` (src/cli/handoff-command.ts, ATO-1154/1155); this file
 * only builds its argv and reads its one-line JSON:
 *
 *   atag handoff --from <agent> --list --json --limit N
 *     → {from, sourceDir, sessions:[{agent,id,mtimeMs,cwd,title,messageCount}]}
 *   atag handoff --from <agent> --session <id> --json
 *     → {ok, sessionId, title, workingDir, from, sourceSessionId, turns,
 *        closedCalls, context, prompt}  |  {ok:false, error}
 *
 * The second one writes the new chat into the shared sessions database; the
 * desktop's own `atag serve` reads it from there, so no restart is needed.
 * The chat is NOT sent anything here: the renderer opens it and puts the
 * continuation message in the composer, so the person picks the model and
 * presses Enter.
 *
 * Connected to an agent on another computer, the handoff would land in THIS
 * computer's database, which that agent never reads — refused in words.
 */

export type HandoffAgentId = "claude-code" | "codex";
export const HANDOFF_AGENTS: readonly HandoffAgentId[] = ["claude-code", "codex"];
export const HANDOFF_LABELS: Record<HandoffAgentId, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** Said when the app runs chats on another computer. */
export const HANDOFF_REMOTE =
  "This app is connected to an agent on another computer. Continue the task there with atag handoff.";
/** Said by an agent from before `atag handoff`. */
export const HANDOFF_TOO_OLD = "This agent version cannot continue Claude Code or Codex sessions. Update Atomic Agent.";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface HandoffSessionRow {
  agent: HandoffAgentId;
  id: string;
  mtimeMs: number;
  cwd: string | null;
  title: string | null;
  messageCount: number;
}

export interface HandoffStarted {
  ok: true;
  sessionId: string;
  title: string;
  workingDir: string;
  prompt: string;
  turns: number;
  closedCalls: number;
  context: { windowTokens: number; compacted: boolean; tokensBefore: number; tokensAfter: number } | null;
}

export type Failure = { ok: false; error: string };

export function isHandoffAgent(value: unknown): value is HandoffAgentId {
  return typeof value === "string" && (HANDOFF_AGENTS as readonly string[]).includes(value);
}

export function handoffListArgs(agent: unknown, limit = 15): { ok: true; args: string[] } | Failure {
  if (!isHandoffAgent(agent)) return { ok: false, error: "agent must be claude-code or codex" };
  const n = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 15;
  return { ok: true, args: ["handoff", "--from", agent, "--list", "--json", "--limit", String(n)] };
}

export function handoffStartArgs(agent: unknown, id: unknown): { ok: true; args: string[] } | Failure {
  if (!isHandoffAgent(agent)) return { ok: false, error: "agent must be claude-code or codex" };
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "session id is not valid" };
  return { ok: true, args: ["handoff", "--from", agent, "--session", id, "--json"] };
}

/** The last stdout line that parses as a JSON object, or null. */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* not this line */ }
  }
  return null;
}

/** An agent without the command answers with its help text and a non-zero exit. */
function tooOld(stdout: string, stderr: string, error?: string): boolean {
  return /unknown command[:\s]+handoff/i.test(`${stdout}\n${stderr}\n${error ?? ""}`);
}

export function parseHandoffList(
  res: { ok: boolean; stdout: string; stderr: string; error?: string },
): { ok: true; sessions: HandoffSessionRow[]; sourceDir: string } | Failure {
  if (tooOld(res.stdout, res.stderr, res.error)) return { ok: false, error: HANDOFF_TOO_OLD };
  const json = lastJsonLine(res.stdout);
  if (!json || !Array.isArray(json["sessions"])) {
    return { ok: false, error: res.error || res.stderr.trim() || "could not read the session list" };
  }
  const sessions: HandoffSessionRow[] = [];
  for (const raw of json["sessions"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (!isHandoffAgent(r["agent"]) || typeof r["id"] !== "string" || !ID_RE.test(r["id"])) continue;
    sessions.push({
      agent: r["agent"],
      id: r["id"],
      mtimeMs: typeof r["mtimeMs"] === "number" ? r["mtimeMs"] : 0,
      cwd: typeof r["cwd"] === "string" ? r["cwd"] : null,
      title: typeof r["title"] === "string" ? r["title"] : null,
      messageCount: typeof r["messageCount"] === "number" ? r["messageCount"] : 0,
    });
  }
  return { ok: true, sessions, sourceDir: typeof json["sourceDir"] === "string" ? json["sourceDir"] : "" };
}

export function parseHandoffStart(
  res: { ok: boolean; stdout: string; stderr: string; error?: string },
): HandoffStarted | Failure {
  if (tooOld(res.stdout, res.stderr, res.error)) return { ok: false, error: HANDOFF_TOO_OLD };
  const json = lastJsonLine(res.stdout);
  if (!json) return { ok: false, error: res.error || res.stderr.trim() || "the handoff did not answer" };
  if (json["ok"] !== true) {
    return { ok: false, error: typeof json["error"] === "string" ? json["error"] : "the handoff failed" };
  }
  if (typeof json["sessionId"] !== "string" || typeof json["prompt"] !== "string") {
    return { ok: false, error: "the handoff answer has no chat id" };
  }
  const ctx = json["context"] as Record<string, unknown> | null | undefined;
  return {
    ok: true,
    sessionId: json["sessionId"],
    title: typeof json["title"] === "string" ? json["title"] : "",
    workingDir: typeof json["workingDir"] === "string" ? json["workingDir"] : "",
    prompt: json["prompt"],
    turns: typeof json["turns"] === "number" ? json["turns"] : 0,
    closedCalls: typeof json["closedCalls"] === "number" ? json["closedCalls"] : 0,
    context:
      ctx && typeof ctx === "object"
        ? {
            windowTokens: Number(ctx["windowTokens"]) || 0,
            compacted: ctx["compacted"] === true,
            tokensBefore: Number(ctx["tokensBefore"]) || 0,
            tokensAfter: Number(ctx["tokensAfter"]) || 0,
          }
        : null,
  };
}

type Run = (args: string[], timeout: number) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;

export async function handoffList(run: Run, agent: unknown, remote: boolean, limit?: number) {
  if (remote) return { ok: false as const, error: HANDOFF_REMOTE };
  const built = handoffListArgs(agent, limit);
  if (!built.ok) return built;
  return parseHandoffList(await run(built.args, 60_000));
}

export async function handoffStart(run: Run, agent: unknown, id: unknown, remote: boolean) {
  if (remote) return { ok: false as const, error: HANDOFF_REMOTE };
  const built = handoffStartArgs(agent, id);
  if (!built.ok) return built;
  return parseHandoffStart(await run(built.args, 120_000));
}
