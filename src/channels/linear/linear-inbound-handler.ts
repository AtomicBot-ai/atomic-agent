/**
 * Inbound dispatch for the Linear channel (ATO-2324): drop, settle an
 * approval, or run the request through the agent and reply as a comment.
 *
 * What reaches the agent:
 * - a new comment from a configured owner (Linear user id) that mentions
 *   one of the agent handles; the reply goes in the same comment thread;
 * - an issue newly assigned to the API key's user, when `onAssign` is on
 *   and an owner did the assigning; the reply is a top-level comment;
 * - an `AgentSessionEvent` when the agent is installed as a Linear app
 *   (ATO-2464, [linear-agent-session.ts](linear-agent-session.ts)); the
 *   reply is an agent activity.
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
import { buildAttachmentUserMessage, type AttachmentInbox } from "../attachments/inbox.js";
import { describeFailedAttempts } from "../../llm/fallback/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { SessionState } from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { agentSessionJob } from "./linear-agent-session.js";
import type { LinearApprovalBridge } from "./linear-approval-bridge.js";
import { findLinearUploads, receiveLinearUploads, type LinearDownload } from "./linear-attachments.js";
import { parseLinearCommand, runLinearCommand } from "./linear-commands.js";
import { mentionsAgent, stripAgentMention } from "./linear-mention.js";
import type { LinearOwnComments } from "./linear-own-comments.js";
import type { LinearTurnQueue } from "./linear-turn-queue.js";
import {
  rememberOnce,
  scrubLinearError,
  type LinearActivityKind,
  type LinearCommentData,
  type LinearIssueData,
  type LinearTarget,
  type LinearWebhookPayload,
} from "./linear-types.js";

export interface LinearInboundContext {
  runtime: AgentRuntime;
  /**
   * Post a comment, or an agent activity of `kind` when the target is an
   * agent session. Records it in `own` first so its echo is ignored.
   */
  post: (target: LinearTarget, body: string, kind?: LinearActivityKind) => Promise<void>;
  sessions: Pick<ChatSessionMap, "get" | "setCurrent" | "rotate">;
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
  bridge: Pick<LinearApprovalBridge, "tryAnswer" | "pendingIn"> | null;
  /** The running and queued turns of each issue. */
  turns: LinearTurnQueue;
  /** Where uploads in a comment land; absent turns attachments off (tests). */
  attachments?: { inbox: AttachmentInbox; download: (url: string) => Promise<LinearDownload> };
  /** Recently handled comment / assignment keys, so a redelivery runs once. */
  seen: Set<string>;
  ensureApprovalSession?: (sessionId: string, target: LinearTarget) => void;
  releaseApprovalSession?: (sessionId: string) => void;
}

/** One unit of work for the agent. */
export interface LinearJob {
  issueId: string;
  target: LinearTarget;
  prompt: string;
  label: string;
}

/** Entry point for one verified webhook. Always resolves; never throws. */
export async function handleLinearEvent(payload: LinearWebhookPayload, ctx: LinearInboundContext): Promise<void> {
  try {
    const job =
      payload.type === "Comment"
        ? await commentJob(payload, ctx)
        : payload.type === "AgentSessionEvent"
          ? await agentSessionJob(payload, ctx, (target, body, kind) => post(ctx, target, body, kind))
          : assignJob(payload, ctx);
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
  if (!rememberOnce(ctx.seen, `comment:${id}`)) return null;

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
  const stripped = stripAgentMention(body, ctx.handles);
  const command = parseLinearCommand(stripped);
  if (command !== null) {
    const reply = runLinearCommand(command, {
      issueId,
      sessions: ctx.sessions,
      turns: ctx.turns,
      pendingApprovals: ctx.bridge?.pendingIn(issueId) ?? 0,
      ...(ctx.releaseApprovalSession ? { releaseApprovalSession: ctx.releaseApprovalSession } : {}),
    });
    await post(ctx, target, reply);
    return null;
  }
  let ask = stripped || "Take a look at this issue.";
  const uploads = ctx.attachments ? findLinearUploads(body) : [];
  if (ctx.attachments && uploads.length > 0) {
    const outcomes = await receiveLinearUploads(uploads, { ...ctx.attachments, logger: ctx.logger });
    ask = buildAttachmentUserMessage(stripped, outcomes);
  }
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
  if (!rememberOnce(ctx.seen, `assign:${data.id}:${payload.webhookTimestamp ?? ""}`)) return null;
  const ref = data.identifier ?? data.id;
  const lines = [`[Linear issue ${ref}: ${data.title ?? ""}] was assigned to you.`];
  if (payload.url) lines.push(payload.url);
  if (data.description) lines.push("", data.description);
  lines.push("", "Work on this issue. Your reply is posted as a comment on it.");
  return { issueId: data.id, target: { issueId: data.id }, label: ref, prompt: lines.join("\n") };
}

async function dispatchToRuntime(job: LinearJob, ctx: LinearInboundContext): Promise<void> {
  if (!ctx.turns.hasRoom(job.issueId)) {
    await post(ctx, job.target, "Too many requests are waiting on this issue. Mention me again once I have answered.");
    return;
  }
  // Queued, not refused: runTurn runs one session's turns in order.
  const queued = ctx.turns.busy(job.issueId);
  const controller = ctx.turns.add(job.issueId);
  if (queued) {
    await post(ctx, job.target, "Queued: I will get to this once I finish the current request on this issue.", "thought");
  }

  let reply: string | null = null;
  let failure: Error | null = null;
  // A queued request cancelled before it started says nothing: `/cancel` already answered.
  let started = false;
  const eventHook = (event: AgentLoopEvent): void => {
    started = true;
    if (event.type === "llm_event" && event.event.type === "assistant_reply" && event.event.progressNote !== true) {
      reply = event.event.text;
    }
    if (event.type === "loop_failed") failure = event.error;
  };
  try {
    const session = acquireOrCreateSession(job, ctx);
    // Bound before any step can ask, so a prompt lands in this thread.
    ctx.ensureApprovalSession?.(session.id, job.target);
    await ctx.runtime.runTurn(session, job.prompt, { origin: "linear", signal: controller.signal, eventHook });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    ctx.turns.remove(job.issueId, controller);
  }

  if (controller.signal.aborted) {
    if (started) await post(ctx, job.target, "Turn cancelled.");
  } else if (reply !== null) {
    await post(ctx, job.target, reply);
  } else if (failure !== null) {
    const err: Error = failure;
    await post(ctx, job.target, `Turn failed: ${scrubLinearError(`${err.message}${describeFailedAttempts(err)}`)}`, "error");
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

/** Post, swallowing transport errors: a failed post must not kill the handler. */
async function post(
  ctx: LinearInboundContext,
  target: LinearTarget,
  body: string,
  kind: LinearActivityKind = "response",
): Promise<void> {
  try {
    await ctx.post(target, body, kind);
  } catch (err) {
    ctx.logger.warn("linear: outbound comment failed", { error: scrubLinearError(err) });
  }
}
