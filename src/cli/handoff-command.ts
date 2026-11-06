import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  HANDOFF_AGENT_LABEL,
  HandoffNotFoundError,
  buildHandoffSession,
  defaultHandoffSourceDir,
  defaultHandoffWindow,
  fitHandoffContext,
  isHandoffAgent,
  listHandoffCandidates,
  readHandoffTranscript,
  type HandoffAgent,
  type HandoffCandidate,
} from "../import/index.js";
import { SessionStore } from "../session/index.js";

export const HANDOFF_HELP =
  [
    "atomic-agent handoff — continue a Claude Code or Codex session here",
    "",
    "When Claude Code or Codex stops mid-task (usage limit, say), this reads",
    "its session, saves it as a new Atomic Agent chat and continues it.",
    "",
    "Usage:",
    "  atomic-agent handoff --from claude-code|codex [options]",
    "",
    "Options:",
    "  --from <agent>        claude-code or codex (required)",
    "  --session <id>        latest (default) or the session id; a unique prefix is enough.",
    "                        latest = the newest session that ran in this folder,",
    "                        else the newest one anywhere",
    "  --source <dir>        Their state dir (default ~/.claude or ~/.codex,",
    "                        env CLAUDE_CODE_STATE_DIR / CODEX_STATE_DIR)",
    "  --cwd <dir>           Folder to continue in (default: the session's own folder)",
    "  --note <text>         Extra instructions added to the continuation message",
    "  --context <tokens>    Window to fit the carried history into (default: the local",
    "                        model's pinned context, else 32768); 0 keeps it all as is",
    "  --list                List their fresh sessions instead (newest first)",
    "  --limit N             How many sessions --list shows (default 10)",
    "  --json                Machine output; saves the chat but does not open it",
    "  --no-open             Save the chat and print how to open it",
    "",
    "Examples:",
    "  atag handoff --from claude-code",
    "  atag handoff --from codex --session 0199a1",
    "  atag handoff --from claude-code --list",
  ].join("\n") + "\n";

interface HandoffArgs {
  agent: HandoffAgent;
  session: string;
  sourceDir: string | null;
  cwd: string | null;
  note: string | null;
  /** `--context`: null = default window, 0 = do not fit. */
  context: number | null;
  list: boolean;
  limit: number;
  json: boolean;
  open: boolean;
}

export function parseHandoffArgs(
  args: string[],
): HandoffArgs | { error: string } | { help: true } {
  let agent: string | null = null;
  let session = "latest";
  let sourceDir: string | null = null;
  let cwd: string | null = null;
  let note: string | null = null;
  let context: number | null = null;
  let list = false;
  let limit = 10;
  let json = false;
  let open = true;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = (): string | null => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i += 1;
      return next;
    };
    switch (flag) {
      case "-h":
      case "--help":
        return { help: true };
      case "--from": {
        const v = value();
        if (!v) return { error: "--from needs claude-code or codex" };
        agent = v;
        break;
      }
      case "--session": {
        const v = value();
        if (!v) return { error: "--session needs latest or a session id" };
        session = v;
        break;
      }
      case "--source": {
        const v = value();
        if (!v) return { error: "--source needs a directory" };
        sourceDir = resolve(v);
        break;
      }
      case "--cwd":
      case "--working-dir": {
        const v = value();
        if (!v) return { error: `${flag} needs a directory` };
        cwd = resolve(v);
        break;
      }
      case "--note": {
        const v = value();
        if (!v) return { error: "--note needs text" };
        note = v;
        break;
      }
      case "--context": {
        const v = value();
        const n = v === null ? NaN : Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return { error: "--context must be a token count (0 keeps the history as is)" };
        context = n;
        break;
      }
      case "--limit": {
        const v = value();
        const n = v === null ? NaN : Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1) return { error: "--limit must be a positive integer" };
        limit = n;
        break;
      }
      case "--list":
        list = true;
        break;
      case "--json":
        json = true;
        break;
      case "--no-open":
        open = false;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (agent === null) return { error: "--from is required (claude-code or codex)" };
  if (!isHandoffAgent(agent)) {
    return { error: `--from must be claude-code or codex, not ${agent}` };
  }
  return { agent, session, sourceDir, cwd, note, context, list, limit, json, open };
}

/** `atag handoff`. 0 done · 1 nothing to continue / failed · 2 usage error. */
export async function handoffCommand(
  args: string[],
  deps: {
    openTui?: (args: string[]) => Promise<number>;
    isTty?: boolean;
  } = {},
): Promise<number> {
  const parsed = parseHandoffArgs(args);
  if ("help" in parsed) {
    process.stdout.write(HANDOFF_HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const label = HANDOFF_AGENT_LABEL[parsed.agent];
  const sourceDir = parsed.sourceDir ?? defaultHandoffSourceDir(parsed.agent);

  if (parsed.list) {
    const candidates = listHandoffCandidates({
      agent: parsed.agent,
      sourceDir,
      limit: parsed.limit,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ from: parsed.agent, sourceDir, sessions: candidates })}\n`);
      return 0;
    }
    if (candidates.length === 0) {
      process.stdout.write(`No ${label} sessions in ${sourceDir}.\n`);
      return 0;
    }
    process.stdout.write(`${label} sessions in ${sourceDir}, newest first:\n`);
    for (const c of candidates) process.stdout.write(`${formatCandidate(c)}\n`);
    return 0;
  }

  let transcript;
  try {
    transcript = readHandoffTranscript({
      agent: parsed.agent,
      sourceDir,
      session: parsed.session,
      workingDir: parsed.cwd ?? process.cwd(),
    });
  } catch (err) {
    if (err instanceof HandoffNotFoundError) {
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      return 1;
    }
    throw err;
  }

  const workingDir = parsed.cwd ?? usableDir(transcript.candidate.cwd) ?? process.cwd();
  const built = buildHandoffSession({
    transcript,
    workingDir,
    ...(parsed.note !== null ? { note: parsed.note } : {}),
  });

  const config = getConfig();
  const windowTokens = parsed.context ?? defaultHandoffWindow(config.localModels.managed?.contextSize ?? 0);
  const fitted =
    windowTokens > 0
      ? fitHandoffContext(built.session, { windowTokens })
      : null;
  const session = fitted?.session ?? built.session;
  const store = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  try {
    store.save(session);
  } finally {
    store.close();
  }

  const title = String(built.session.metadata.title ?? "");
  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        sessionId: built.session.id,
        title,
        workingDir,
        from: parsed.agent,
        sourceSessionId: transcript.candidate.id,
        turns: built.session.turns.length,
        closedCalls: built.closedCalls,
        context: fitted
          ? {
              windowTokens,
              compacted: fitted.compacted,
              tokensBefore: fitted.tokensBefore,
              tokensAfter: fitted.tokensAfter,
              summarizedTurns: fitted.summarizedTurns,
              clippedResults: fitted.clippedResults,
            }
          : null,
        prompt: built.prompt,
      })}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `Continuing ${label} session ${transcript.candidate.id}\n` +
      `  title:  ${title}\n` +
      `  folder: ${workingDir}\n` +
      `  turns:  ${built.session.turns.length}` +
      (built.closedCalls > 0
        ? ` (${built.closedCalls} unanswered tool call${built.closedCalls === 1 ? "" : "s"} marked as cut off)`
        : "") +
      `\n` +
      (fitted?.compacted
        ? `  history: ~${fitted.tokensBefore} → ~${fitted.tokensAfter} tokens for a ${windowTokens}-token window ` +
          `(first ${fitted.summarizedTurns} records summarised, the rest kept as is)\n`
        : "") +
      `  saved as chat ${built.session.id}\n`,
  );

  const isTty = deps.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!parsed.open || !isTty) {
    process.stdout.write(
      `\nOpen it: atag tui --cwd ${shellQuote(workingDir)} --session ${built.session.id}\n` +
        `then send: ${built.prompt.split("\n")[0]}\n`,
    );
    return 0;
  }
  // The TUI is injected by the CLI composition root (src/cli/index.ts):
  // CLI commands do not import src/tui directly (scripts/check-imports.mjs).
  const openTui = deps.openTui;
  if (!openTui) {
    process.stdout.write(`\nOpen it: atag tui --cwd ${shellQuote(workingDir)} --session ${built.session.id}\n`);
    return 0;
  }
  return openTui(["--cwd", workingDir, "--session", built.session.id, "--send", built.prompt]);
}

function formatCandidate(c: HandoffCandidate): string {
  const when = new Date(c.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
  const title = c.title ?? "(untitled)";
  const where = c.cwd ?? "?";
  return `  ${c.id}  ${when}  ${c.messageCount} msgs  ${where}\n      ${title}`;
}

function usableDir(dir: string | null): string | null {
  if (dir === null) return null;
  try {
    return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
