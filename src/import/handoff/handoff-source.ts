import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SessionState } from "../../session/session-state.js";
import {
  ClaudeCodeSource,
  type ClaudeCodeSessionMeta,
} from "../claude-code/claude-code-source.js";
import { mapClaudeCodeSession } from "../claude-code/map-session.js";
import { CodexSource, type CodexSessionMeta } from "../codex/codex-source.js";
import { mapCodexSession } from "../codex/map-session.js";

/**
 * Read side of `atag handoff`: find the fresh sessions of another coding
 * agent and turn one into a native `SessionState`. It reuses the import
 * readers (`ClaudeCodeSource`, `CodexSource`) and mappers unchanged, so a
 * handoff and an `atag import` see the same transcript.
 */

/** Agents a task can be handed off from. */
export type HandoffAgent = "claude-code" | "codex";

export const HANDOFF_AGENTS: readonly HandoffAgent[] = ["claude-code", "codex"];

/** Human label, used in titles and the continuation prompt. */
export const HANDOFF_AGENT_LABEL: Record<HandoffAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function isHandoffAgent(value: string): value is HandoffAgent {
  return (HANDOFF_AGENTS as readonly string[]).includes(value);
}

/**
 * The agent's state dir: `--source` wins, then the same env vars
 * `atag import` reads, then the home default.
 */
export function defaultHandoffSourceDir(
  agent: HandoffAgent,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (agent === "claude-code") {
    return env.CLAUDE_CODE_STATE_DIR ?? join(home, ".claude");
  }
  return env.CODEX_STATE_DIR ?? join(home, ".codex");
}

/** One fresh session, enough to list it and pick it. */
export interface HandoffCandidate {
  agent: HandoffAgent;
  /** The other agent's own session id. */
  id: string;
  /** Last write to its transcript, ms. */
  mtimeMs: number;
  cwd: string | null;
  title: string | null;
  /** Count of user + assistant messages in the transcript. */
  messageCount: number;
}

/** A session read in full and mapped onto our model. */
export interface HandoffTranscript {
  candidate: HandoffCandidate;
  /** The mapped session; ids and metadata are still the import's. */
  mapped: SessionState;
}

const TITLE_MAX = 80;

interface Adapter {
  metas(): { id: string; file: string; mtimeMs: number }[];
  read(
    meta: { id: string; file: string; mtimeMs: number },
    fallbackDir: string,
  ): { cwd: string | null; title: string | null; count: number; mapped: SessionState };
}

function adapterFor(agent: HandoffAgent, sourceDir: string): Adapter {
  if (agent === "claude-code") {
    const source = new ClaudeCodeSource(sourceDir);
    return {
      metas: () => source.listSessions(),
      read: (meta, fallbackDir) => {
        const data = source.readSession(meta as ClaudeCodeSessionMeta);
        return {
          cwd: data.cwd,
          title: data.title ?? firstUserLine(data.messages),
          count: data.messages.length,
          mapped: mapClaudeCodeSession(data, fallbackDir),
        };
      },
    };
  }
  const source = new CodexSource(sourceDir);
  return {
    metas: () => source.listSessions(),
    read: (meta, fallbackDir) => {
      const data = source.readSession(meta as CodexSessionMeta);
      return {
        cwd: data.cwd,
        title: firstUserLine(data.messages),
        count: data.messages.filter((m) => m.role !== "tool").length,
        mapped: mapCodexSession(data, fallbackDir),
      };
    },
  };
}

/** The first line the operator typed, clipped — a title for untitled sessions. */
function firstUserLine(
  messages: readonly {
    role: string;
    blocks: readonly { type: string; text?: string }[];
  }[],
): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.blocks) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const line = block.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (line.length === 0) continue;
      return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
    }
  }
  return null;
}

export interface ListHandoffInput {
  agent: HandoffAgent;
  sourceDir: string;
  /** How many of the newest transcripts to open. Default 10. */
  limit?: number;
}

/**
 * The newest sessions, newest first. Each listed one is read in full
 * (cwd and title live inside the transcript), so `limit` bounds the
 * cost; an unreadable or empty transcript is skipped, not fatal.
 */
export function listHandoffCandidates(input: ListHandoffInput): HandoffCandidate[] {
  const limit = Math.max(0, input.limit ?? 10);
  const adapter = adapterFor(input.agent, input.sourceDir);
  const out: HandoffCandidate[] = [];
  for (const meta of adapter.metas()) {
    if (out.length >= limit) break;
    let read: ReturnType<Adapter["read"]>;
    try {
      read = adapter.read(meta, process.cwd());
    } catch {
      continue;
    }
    if (read.count === 0) continue;
    out.push({
      agent: input.agent,
      id: meta.id,
      mtimeMs: meta.mtimeMs,
      cwd: read.cwd,
      title: read.title,
      messageCount: read.count,
    });
  }
  return out;
}

export interface ReadHandoffInput {
  agent: HandoffAgent;
  sourceDir: string;
  /** `"latest"` or the agent's session id (a unique prefix is enough). */
  session: string;
  /**
   * The folder the operator is in. `latest` prefers the newest session
   * that ran in this folder, and falls back to the newest overall.
   */
  workingDir: string;
  /** How many newest transcripts `latest` looks through for a folder match. Default 20. */
  scan?: number;
}

export class HandoffNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffNotFoundError";
  }
}

/** Pick one session and read it in full. Throws `HandoffNotFoundError`. */
export function readHandoffTranscript(input: ReadHandoffInput): HandoffTranscript {
  const adapter = adapterFor(input.agent, input.sourceDir);
  const metas = adapter.metas();
  const label = HANDOFF_AGENT_LABEL[input.agent];
  if (metas.length === 0) {
    throw new HandoffNotFoundError(
      `no ${label} sessions found in ${input.sourceDir}`,
    );
  }
  const build = (
    meta: (typeof metas)[number],
    read: ReturnType<Adapter["read"]>,
  ): HandoffTranscript => ({
    candidate: {
      agent: input.agent,
      id: meta.id,
      mtimeMs: meta.mtimeMs,
      cwd: read.cwd,
      title: read.title,
      messageCount: read.count,
    },
    mapped: read.mapped,
  });

  if (input.session !== "latest") {
    const exact = metas.filter((m) => m.id === input.session);
    const matches =
      exact.length > 0 ? exact : metas.filter((m) => m.id.startsWith(input.session));
    if (matches.length === 0) {
      throw new HandoffNotFoundError(`no ${label} session matches "${input.session}"`);
    }
    if (matches.length > 1) {
      throw new HandoffNotFoundError(
        `"${input.session}" matches ${matches.length} ${label} sessions; give more of the id`,
      );
    }
    const meta = matches[0]!;
    return build(meta, adapter.read(meta, input.workingDir));
  }

  const here = resolve(input.workingDir);
  const scan = Math.max(1, input.scan ?? 20);
  let newest: HandoffTranscript | null = null;
  for (const meta of metas.slice(0, scan)) {
    let read: ReturnType<Adapter["read"]>;
    try {
      read = adapter.read(meta, input.workingDir);
    } catch {
      continue;
    }
    if (read.count === 0) continue;
    const transcript = build(meta, read);
    if (read.cwd !== null && resolve(read.cwd) === here) return transcript;
    newest ??= transcript;
  }
  if (newest === null) {
    throw new HandoffNotFoundError(`no readable ${label} session in ${input.sourceDir}`);
  }
  return newest;
}
