/**
 * Linear agent sessions (Linear Agents API, ATO-2464).
 *
 * When Atomic Agent is installed in the workspace as a Linear app
 * (OAuth `actor=app`), people mention it or delegate an issue to it like
 * a teammate, and Linear sends an `AgentSessionEvent` instead of a plain
 * comment: `created` when a session starts, `prompted` for every
 * follow-up in it (or a Stop press). The agent answers with activities
 * (`thought`, `response`, `elicitation`, `error`) that Linear shows as
 * the agent's live progress. Same precedent as Cursor, Devin and Codex
 * in Linear.
 *
 * Rules are the comment channel's: only configured owners drive it, the
 * issue is one conversation (the same session as comment mentions on
 * it), approvals are answered `yes <code>`, and `/status`, `/new`,
 * `/cancel` work. Linear marks a session unresponsive when nothing comes
 * back within ten seconds, so `created` is acknowledged with a thought
 * before any slow step.
 */

import { buildAttachmentUserMessage } from "../attachments/inbox.js";
import { findLinearUploads, receiveLinearUploads } from "./linear-attachments.js";
import { parseLinearCommand, runLinearCommand } from "./linear-commands.js";
import type { LinearInboundContext, LinearJob } from "./linear-inbound-handler.js";
import { rememberOnce, type LinearActivityKind, type LinearTarget, type LinearWebhookPayload } from "./linear-types.js";

export const LINEAR_AGENT_NOT_OWNER =
  "I only take requests from the people set as owners in Atomic Agent. Ask one of them to add you.";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);

/** Leading `@handle` or `[@Name](https://linear.app/<org>/profiles/<handle>)`, which addressed the app. */
export function stripLeadingMention(body: string): string {
  return body
    .replace(/^\s*(?:\[[^\]]*\]\(https?:\/\/linear\.app\/[^)\s]*\/profiles\/[^)\s]*\)|@[A-Za-z0-9._-]+)[\s,:]*/, "")
    .trim();
}

type Post = (target: LinearTarget, body: string, kind: LinearActivityKind) => Promise<void>;

/** The job an `AgentSessionEvent` asks for, or `null` after answering it directly. */
export async function agentSessionJob(
  payload: LinearWebhookPayload,
  ctx: LinearInboundContext,
  post: Post,
): Promise<LinearJob | null> {
  const session = payload.agentSession;
  const sessionId = str(session?.id);
  if (!session || !sessionId) return null;
  const issueId = str(session.issue?.id) ?? str(session.issueId);
  const key = issueId ?? `agent:${sessionId}`;
  const target: LinearTarget = { issueId: key, agentSessionId: sessionId };
  const creatorId = str(session.creator?.id) ?? str(session.creatorId);
  const ref = str(session.issue?.identifier) ?? issueId ?? "agent session";
  const title = str(session.issue?.title);
  const header = title ? `[Linear agent session on ${ref}: ${title}]` : `[Linear agent session on ${ref}]`;

  if (payload.action === "created") {
    if (!rememberOnce(ctx.seen, `agent:${sessionId}:created`)) return null;
    // The comment that started the session can also arrive as a Comment webhook: run it once.
    const startId = str(session.comment?.id);
    if (startId) rememberOnce(ctx.seen, `comment:${startId}`);
    if (!creatorId || !ctx.ownerIds.includes(creatorId)) {
      ctx.logger.warn("linear: dropping agent session from non-owner", { userId: creatorId, ownerConfigured: ctx.ownerIds.length > 0 });
      await post(target, LINEAR_AGENT_NOT_OWNER, "error");
      return null;
    }
    // Within Linear's ten seconds, before attachments or a queue.
    await post(target, "Working on it.", "thought");
    const said = stripLeadingMention(str(session.comment?.body) ?? "");
    const answered = await answerDirectly(said, key, target, ctx, post);
    if (answered) return null;
    const context = str(payload.promptContext) ?? (said || "Take a look at this issue.");
    const ask = await withUploads(context, said, ctx);
    return { issueId: key, target, label: ref, prompt: [header, payload.url ?? "", "", ask].filter((l, i) => i !== 1 || l !== "").join("\n") };
  }

  if (payload.action !== "prompted") return null;
  const activity = payload.agentActivity;
  const activityKey = str(activity?.id) ?? String(payload.webhookTimestamp ?? "");
  if (!rememberOnce(ctx.seen, `agent:${sessionId}:${activityKey}`)) return null;
  const authorId = str(activity?.userId) ?? str(activity?.user?.id);
  // Without an author on the activity, the session's creator stands in.
  const who = authorId ?? creatorId;
  if (!who || !ctx.ownerIds.includes(who)) {
    ctx.logger.warn("linear: dropping agent prompt from non-owner", { userId: who });
    await post(target, LINEAR_AGENT_NOT_OWNER, "error");
    return null;
  }
  if (activity?.signal === "stop") {
    const n = ctx.turns.cancel(key);
    await post(target, n > 0 ? "Stopped." : "Nothing was running.", "response");
    return null;
  }
  const said = stripLeadingMention(str(activity?.content?.body) ?? str(activity?.body) ?? "");
  if (!said) return null;
  if (await answerDirectly(said, key, target, ctx, post)) return null;
  const name = str(activity?.user?.name);
  const ask = await withUploads(said, said, ctx);
  return { issueId: key, target, label: ref, prompt: [header, "", `${name ? `Follow-up from ${name}` : "Follow-up"}:`, ask].join("\n") };
}

/** An approval answer or a command: answered here, no turn. */
async function answerDirectly(
  said: string,
  key: string,
  target: LinearTarget,
  ctx: LinearInboundContext,
  post: Post,
): Promise<boolean> {
  const answer = ctx.bridge?.tryAnswer(key, said) ?? null;
  if (answer !== null) {
    await post(target, answer, "response");
    return true;
  }
  const command = parseLinearCommand(said);
  if (command === null) return false;
  const reply = runLinearCommand(command, {
    issueId: key,
    sessions: ctx.sessions,
    turns: ctx.turns,
    pendingApprovals: ctx.bridge?.pendingIn(key) ?? 0,
    ...(ctx.releaseApprovalSession ? { releaseApprovalSession: ctx.releaseApprovalSession } : {}),
  });
  await post(target, reply, "response");
  return true;
}

/** `text` plus the attachments block when `source` links Linear uploads. */
async function withUploads(text: string, source: string, ctx: LinearInboundContext): Promise<string> {
  const uploads = ctx.attachments ? findLinearUploads(source) : [];
  if (!ctx.attachments || uploads.length === 0) return text;
  const outcomes = await receiveLinearUploads(uploads, { ...ctx.attachments, logger: ctx.logger });
  return buildAttachmentUserMessage(text, outcomes);
}
