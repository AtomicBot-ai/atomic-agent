/**
 * Argument parsing shared by the `github.*` tools. Each helper names
 * the tool and the field in its error so the model can fix the call
 * instead of guessing which of six tools rejected what.
 */

import type { ToolContext } from "../tool-registry.js";
import {
  parseGithubRemote,
  parseRepoSlug,
  type GithubRepoRef,
} from "../../github/index.js";
import { runGit } from "../os/git/git-runner.js";

/**
 * `repo` argument → `{ owner, repo }`, falling back to the `origin`
 * remote of the working directory. A non-GitHub origin is an error
 * that says so, never a guess.
 */
export async function resolveRepo(
  raw: unknown,
  ctx: ToolContext,
  tool: string,
): Promise<GithubRepoRef> {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const ref = parseRepoSlug(raw);
    if (!ref) {
      throw new Error(
        `${tool}: \`repo\` must be owner/name or a github.com URL, got ${JSON.stringify(raw)}`,
      );
    }
    return ref;
  }
  let url: string;
  try {
    const res = await runGit({
      workingDir: ctx.workingDir,
      // The push URL: a PR points at where the branch went, and a
      // `pushInsteadOf` rewrite can send pushes somewhere fetches do not go.
      args: ["remote", "get-url", "--push", "origin"],
      signal: ctx.signal,
      timeoutMs: 5_000,
    });
    url = res.exitCode === 0 ? res.stdout.trim() : "";
  } catch {
    url = "";
  }
  if (!url) {
    throw new Error(
      `${tool}: no \`repo\` given and the working directory has no origin remote — pass \`repo: "owner/name"\``,
    );
  }
  const ref = parseGithubRemote(url);
  if (!ref) {
    throw new Error(
      `${tool}: origin (${url}) is not on github.com — pass \`repo: "owner/name"\` explicitly`,
    );
  }
  return ref;
}

export async function currentBranch(ctx: ToolContext): Promise<string> {
  const res = await runGit({
    workingDir: ctx.workingDir,
    args: ["symbolic-ref", "--short", "-q", "HEAD"],
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  const branch = res.stdout.trim();
  if (res.exitCode !== 0 || !branch) {
    throw new Error(
      "github.pr.create: could not read the current branch — pass `head` explicitly",
    );
  }
  return branch;
}

export function requireString(
  raw: unknown,
  tool: string,
  field: string,
): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${tool}: \`${field}\` must be a non-empty string`);
  }
  return raw.trim();
}

export function optionalString(
  raw: unknown,
  tool: string,
  field: string,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`${tool}: \`${field}\` must be a string`);
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requireNumber(
  raw: unknown,
  tool: string,
  field: string,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${tool}: \`${field}\` must be a positive number`);
  }
  return Math.floor(raw);
}

export function parseStringArray(
  raw: unknown,
  tool: string,
  field: string,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
    throw new Error(`${tool}: \`${field}\` must be an array of strings`);
  }
  const values = (raw as string[])
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return values.length > 0 ? values : undefined;
}

export function parseState(
  raw: unknown,
  tool: string,
): "open" | "closed" | "all" {
  if (raw === undefined || raw === null) return "open";
  if (raw === "open" || raw === "closed" || raw === "all") return raw;
  throw new Error(`${tool}: \`state\` must be open, closed or all`);
}

export function parseLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 20;
  return Math.min(100, Math.floor(raw));
}
