/**
 * ATO-1157 — the Agents sheet's list: the person's Claude Code and Codex
 * sessions of the last day, newest first, each with what it is doing
 * (agent-hub-classify.ts says how that is guessed).
 *
 *   Claude Code  <CLAUDE_CODE_STATE_DIR or ~/.claude>/projects/<slug>/<uuid>.jsonl
 *   Codex        <CODEX_STATE_DIR or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * The folders are the ones `atag handoff` reads (src/import/handoff/
 * handoff-source.ts defaultHandoffSourceDir), and a row's `id` is the id
 * that command takes, so "Continue here" hands it straight to the existing
 * handoff sheet.
 *
 * These transcripts grow to tens of MB and the sheet refreshes on demand,
 * so a file is never read whole: its last TAIL_BYTES (the state lives
 * there) and its first HEAD_BYTES (the title and the folder often live
 * there), the cut partial line dropped. Read-only: nothing is written into
 * either folder. Every fs call goes through `deps`, so the tests drive it
 * on a fake disk (test/agent-hub.test.mjs).
 */

import { join } from "node:path";

import { classifyClaudeTail, classifyCodexTail, type HubState } from "./agent-hub-classify.js";

export { classifyClaudeTail, classifyCodexTail } from "./agent-hub-classify.js";

export type HubAgent = "claude-code" | "codex";

export interface HubStat {
  mtimeMs: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface HubFsDeps {
  readdir(dir: string): string[];
  stat(path: string): HubStat | null;
  /** `length` bytes from `start`, as UTF-8. */
  read(path: string, start: number, length: number): string;
}

export interface HubSession {
  agent: HubAgent;
  /** The id `atag handoff --session` takes (Claude: the uuid; Codex: the name after `rollout-`). */
  id: string;
  /** The id the agent's own resume takes (`claude --resume`, `codex resume`); null when unknown. */
  resumeId: string | null;
  mtimeMs: number;
  cwd: string | null;
  title: string | null;
  state: HubState;
  reason: string;
}

export interface ScanInput {
  home: string;
  env?: Record<string, string | undefined>;
  now: number;
  maxAgeMs?: number;
  limit?: number;
  deps: HubFsDeps;
}

export const TAIL_BYTES = 64 * 1024;
export const HEAD_BYTES = 16 * 1024;
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60_000;
export const DEFAULT_LIMIT = 30;
/** Codex nests sessions/YYYY/MM/DD; a little slack, and no runaway walk. */
const CODEX_MAX_DEPTH = 5;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function hubSourceDir(agent: HubAgent, home: string, env: Record<string, string | undefined> = {}): string {
  if (agent === "claude-code") return env["CLAUDE_CODE_STATE_DIR"] || join(home, ".claude");
  return env["CODEX_STATE_DIR"] || join(home, ".codex");
}

interface Found {
  agent: HubAgent;
  id: string;
  file: string;
  stat: HubStat;
}

function safeReaddir(deps: HubFsDeps, dir: string): string[] {
  try {
    const list = deps.readdir(dir);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function safeStat(deps: HubFsDeps, path: string): HubStat | null {
  try {
    return deps.stat(path) || null;
  } catch {
    return null;
  }
}

function findClaude(deps: HubFsDeps, root: string, cutoff: number, out: Found[]): void {
  const projects = join(root, "projects");
  for (const slug of safeReaddir(deps, projects)) {
    const dir = join(projects, slug);
    for (const name of safeReaddir(deps, dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const stat = safeStat(deps, file);
      if (!stat || !stat.isFile || stat.mtimeMs < cutoff) continue;
      const id = name.slice(0, -".jsonl".length);
      if (SAFE_ID_RE.test(id)) out.push({ agent: "claude-code", id, file, stat });
    }
  }
}

function findCodex(deps: HubFsDeps, dir: string, depth: number, cutoff: number, out: Found[]): void {
  if (depth > CODEX_MAX_DEPTH) return;
  for (const name of safeReaddir(deps, dir)) {
    const path = join(dir, name);
    const stat = safeStat(deps, path);
    if (!stat) continue;
    if (stat.isDirectory) { findCodex(deps, path, depth + 1, cutoff, out); continue; }
    if (!stat.isFile || !name.startsWith("rollout-") || !name.endsWith(".jsonl") || stat.mtimeMs < cutoff) continue;
    const id = name.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    if (SAFE_ID_RE.test(id)) out.push({ agent: "codex", id, file: path, stat });
  }
}

/** The file's first and last lines, at most HEAD_BYTES + TAIL_BYTES read. */
export function readEnds(deps: HubFsDeps, file: string, size: number): { head: string[]; tail: string[] } {
  const split = (text: string) => String(text || "").split(/\r?\n/);
  if (size <= HEAD_BYTES + TAIL_BYTES) return { head: [], tail: split(deps.read(file, 0, size)) };
  const head = split(deps.read(file, 0, HEAD_BYTES));
  head.pop();   // cut mid-line
  const tail = split(deps.read(file, size - TAIL_BYTES, TAIL_BYTES));
  tail.shift();   // cut mid-line
  return { head, tail };
}

export function scanAgentSessions(input: ScanInput): HubSession[] {
  const deps = input.deps;
  const env = input.env || {};
  const maxAge = typeof input.maxAgeMs === "number" && input.maxAgeMs > 0 ? input.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;
  const cutoff = input.now - maxAge;
  const found: Found[] = [];
  findClaude(deps, hubSourceDir("claude-code", input.home, env), cutoff, found);
  findCodex(deps, join(hubSourceDir("codex", input.home, env), "sessions"), 0, cutoff, found);
  found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out: HubSession[] = [];
  for (const f of found.slice(0, limit)) {
    let ends: { head: string[]; tail: string[] };
    try {
      ends = readEnds(deps, f.file, f.stat.size);
    } catch {
      continue;   // gone or unreadable since the listing: skip it, keep the rest
    }
    const opts = { ageMs: Math.max(0, input.now - f.stat.mtimeMs), headLines: ends.head };
    const c = f.agent === "claude-code" ? classifyClaudeTail(ends.tail, opts) : classifyCodexTail(ends.tail, opts);
    const resumeId = f.agent === "claude-code" ? f.id : (c.sessionId && SAFE_ID_RE.test(c.sessionId) ? c.sessionId : (f.id.match(UUID_RE)?.[0] ?? null));
    out.push({
      agent: f.agent, id: f.id, resumeId, mtimeMs: f.stat.mtimeMs,
      cwd: c.cwd, title: c.title, state: c.state, reason: c.reason,
    });
  }
  return out;
}
