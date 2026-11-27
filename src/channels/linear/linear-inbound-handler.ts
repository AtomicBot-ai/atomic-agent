/**
 * Inbound dispatch for the Linear channel (ATO-2324): drop, settle an
 * approval, or run the request through the agent and reply as a comment.
 *
 * What reaches the agent:
 * - a new comment from a configured owner (Linear user id) that mentions
 *   one of the agent handles; the reply goes in the same comment thread;
 * - an issue newly assigned to the API key's user, when `onAssign` is on
 *   and an owner did the assigning; the reply is a top-level comment.
 *
 * One session per issue: every trigger on the same issue continues the
 * same conversation (`<stateDir>/linear-session.json`). The channel never
 * changes an issue itself; a status change is a tool call and goes
 * through the approval gate like any other.
 *
 * Same hardest rule as the other channels: **never throw past this
 * boundary**, so one odd payload cannot take the endpoint down.
 */

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import type { LinearApprovalBridge } from "./linear-approval-bridge.js";
import { mentionsAgent, stripAgentMention } from "./linear-mention.js";
import type { LinearOwnComments } from "./linear-own-comments.js";
import {
  scrubLinearError,
  type LinearCommentData,
  type LinearIssueData,
  type LinearTarget,
  type LinearWebhookPayload,
} from "./linear-types.js";

export interface LinearInboundContext {
  runtime: AgentRuntime;
  /** Post a comment. Records it in `own` first so its echo is ignored. */
  post: (target: LinearTarget, body: string) => Promise<void>;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent">;
  logger: StructuredLogger;
  /** Linear user ids allowed to drive the agent. Empty refuses everyone. */
  ownerIds: readonly string[];
  /** Handles that address the agent, lower-case, no `@`. */
  handles: readonly string[];
  /** The user the API key acts as; `null` when `viewer` was not reachable. */
  viewerId: string | null;
  /** Start a session when an issue is assigned to `viewerId`. */
  onAssign: boolean;
  own: Pick<LinearOwnComments, "isOwn">;
  bridge: Pick<LinearApprovalBridge, "tryAnswer"> | null;
  /** `issueId -> AbortController` for the turn in flight. */
  inflight: Map<string, AbortController>;
  /** Recently handled comment / assignment keys, so a redelivery runs once. */
  seen: Set<string>;
  ensureApprovalSession?: (sessionId: string, target: LinearTarget) => void;
  releaseApprovalSession?: (sessionId: string) => void;
}

const SEEN_CAP = 500;

/** One unit of work for the agent. */
interface LinearJob {
  issueId: string;
  target: LinearTarget;
  prompt: string;
  label: string;
}

/** Entry point for one verified webhook. Always resolves; never throws. */
export async function handleLinearEvent(payload: LinearWebhookPayload, ctx: LinearInboundContext): Promise<void> {
  try {
    const job = payload.type === "Comment" ? await commentJob(payload, ctx) : assignJob(payload, ctx);
    if (job) await dispatchToRuntime(job, ctx);
  } catch (err) {
    ctx.logger.warn("linear: inbound handler failed", { error: scrubLinearError(err) });
  }
}

async function commentJob(payload: LinearWebhookPayload, ctx: LinearInboundContext): Promise<LinearJob | null> {
  if (payload.action !== "create") return null;
  const data = (payload.data ?? {}) as LinearCommentData;
  const { id, issueId, body, userId } = data;
  if (typeof id !== "string" || typeof issueId !== "string" || typeof body !== "string") return null;
  // Loop guard: our own replies and prompts, and comments written by apps.
  if (ctx.own.isOwn(id, body, userId !== undefined && userId === ctx.viewerId)) return null;
  if (data.botActor !== undefined && data.botActor !== null) return null;
  if (typeof userId !== "string") return null;
  if (!remember(ctx.seen, `comment:${id}`)) return null;

  const isOwner = ctx.ownerIds.includes(userId);
  const target: LinearTarget = { issueId, parentId: data.parentId ?? id };
  // An approval answer needs no mention: "yes ABCD" in the thread is enough.
  if (isOwner && ctx.bridge) {
    const answer = ctx.bridge.tryAnswer(issueId, body);
    if (answer !== null) {
      await post(ctx, target, answer);
      return null;
    }
  }
  if (!mentionsAgent(body, ctx.handles)) return null;
  if (!isOwner) {
    ctx.logger.warn("linear: dropping mention from non-owner", {
      userId,
      ownerConfigured: ctx.ownerIds.length > 0,
    });
    return null;
  }
  const ask = stripAgentMention(body, ctx.handles) || "Take a look at this issue.";
  const issue = data.issue;
  const ref = issue?.identifier ?? issueId;
  const header = issue?.title ? `[Linear issue ${ref}: ${issue.title}]` : `[Linear issue ${ref}]`;
  const from = payload.actor?.name ? `Comment from ${payload.actor.name}` : "Comment";
  return {
    issueId,
    target,
    label: ref,
    prompt: [header, payload.url ?? "", "", `${from}:`, ask].filter((l, i) => i !== 1 || l !== "").join("\n"),
  };
}

function assignJob(payload: LinearWebhookPayload, ctx: LinearInboundContext): LinearJob | null {
  if (payload.type !== "Issue" || payload.action !== "update" || !ctx.onAssign || ctx.viewerId === null) return null;
  const data = (payload.data ?? {}) as LinearIssueData;
  if (typeof data.id !== "string" || data.assigneeId !== ctx.viewerId) return null;
  // Only the moment of assignment, not every later edit of an assigned issue.
  if (!payload.updatedFrom || !("assigneeId" in payload.updatedFrom)) return null;
  if (payload.updatedFrom.assigneeId === ctx.viewerId) return null;
  const actorId = payload.actor?.id;
  if (typeof actorId !== "string" || !ctx.ownerIds.includes(actorId)) {
    ctx.logger.warn("linear: ignoring assignment by non-owner", { userId: actorId });
    return null;
  }
  if (!remember(ctx.seen, `assign:${data.id}:${payload.webhookTimestamp ?? ""}`)) return null;
  const ref = data.identifier ?? data.id;
  const lines = [`[Linear issue ${ref}: ${data.title ?? ""}] was assigned to you.`];
  if (payload.url) lines.push(payload.url);
  if (data.description) lines.push("", data.description);
  lines.push("", "Work on this issue. Your reply is posted as a comment on it.");
  return { issueId: data.id, target: { issueId: data.id }, label: ref, prompt: lines.join("\n") };
}

async function dispatchToRuntime(job: LinearJob, ctx: LinearInboundContext): Promise<void> {
  if (ctx.inflight.has(job.issueId)) {
    await post(ctx, job.target, "I am already working on this issue. Mention me again once I have answered.");
    return;
  }
  const session = acquireOrCreateSession(job, ctx);
  // Bound before any step can ask, so a prompt lands in this thread.
  ctx.ensureApprovalSession?.(session.id, job.target);
  const controller = new AbortController();
  ctx.inflight.set(job.issueId, controller);

  let reply: string | null = null;
  let failure: Error | null = null;
  const eventHook = (event: AgentLoopEvent): void => {
    if (event.type === "llm_event" && event.event.type === "assistant_reply" && event.event.progressNote !== true) {
      reply = event.event.text;
    }
    if (event.type === "loop_failed") failure = event.error;
  };
  try {
    await ctx.runtime.runTurn(session, job.prompt, { origin: "linear", signal: controller.signal, eventHook });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (ctx.inflight.get(job.issueId) === controller) ctx.inflight.delete(job.issueId);
  }

  if (controller.signal.aborted) {
    await post(ctx, job.target, "Turn cancelled.");
  } else if (reply !== null) {
    await post(ctx, job.target, reply);
  } else if (failure !== null) {
    const err: Error = failure;
    await post(ctx, job.target, `Turn failed: ${scrubLinearError(`${err.message}${describeFailedAttempts(err)}`)}`);
  } else {
    await post(ctx, job.target, "(no reply)");
  }
}

/** The issue's session, created on first contact and kept for every later trigger. */
export function acquireOrCreateSession(
  job: Pick<LinearJob, "issueId" | "label">,
  ctx: Pick<LinearInboundContext, "runtime" | "sessions" | "logger" | "releaseApprovalSession">,
): SessionState {
  const current = ctx.sessions.get(job.issueId).current;
  if (current) {
    const existing = ctx.runtime.sessionStore.load(current);
    if (existing) return existing;
    ctx.logger.warn("linear: pointer references missing session, recreating", { sessionId: current });
    ctx.releaseApprovalSession?.(current);
  }
  const fresh = ctx.runtime.createSession({
    metadata: { linearChannel: true, linearIssue: { issueId: job.issueId, label: job.label } },
  });
  ctx.sessions.setCurrent(job.issueId, fresh.id, job.label);
  return fresh;
}

/** Add `key`; false when it was already there (a redelivery). */
function remember(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Post, swallowing transport errors: a failed post must not kill the handler. */
async function post(ctx: LinearInboundContext, target: LinearTarget, body: string): Promise<void> {
  try {
    await ctx.post(target, body);
  } catch (err) {
    ctx.logger.warn("linear: outbound comment failed", { error: scrubLinearError(err) });
  }
}
