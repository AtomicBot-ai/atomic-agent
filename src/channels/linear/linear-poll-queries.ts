/**
 * What the Linear poller asks for and how the answers become the same
 * payloads a webhook would deliver (ATO-2464). Pure apart from the one
 * `query` call each, so the mapping is tested without a timer.
 *
 * Polling reads two things since the cursor: new comments in the
 * workspace (mentions and approval answers) and, when assignment
 * triggers are on, issues assigned to the API key's user together with
 * the history entry that assigned them (who did it, and from whom), so
 * `handleLinearEvent` applies exactly the same owner and loop rules as
 * for a webhook.
 */

import type { LinearApi } from "./linear-api.js";
import type { LinearWebhookPayload } from "./linear-types.js";

/** Pages read per poll; past this the rest waits for the next poll. */
export const LINEAR_POLL_MAX_PAGES = 4;
const PAGE_SIZE = 50;

const COMMENTS_QUERY = `query AtomicAgentRecentComments($since: DateTimeOrDuration!, $after: String) {
  comments(first: ${PAGE_SIZE}, after: $after, orderBy: createdAt, filter: { createdAt: { gt: $since } }) {
    nodes { id body createdAt url parent { id } user { id name } botActor { id name } issue { id identifier title url } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ASSIGNED_QUERY = `query AtomicAgentRecentAssignments($viewer: ID!, $since: DateTimeOrDuration!) {
  issues(first: ${PAGE_SIZE}, filter: { assignee: { id: { eq: $viewer } }, updatedAt: { gt: $since } }) {
    nodes { id identifier title description url history(first: 20) { nodes { createdAt actorId fromAssigneeId toAssigneeId } } }
  }
}`;

type Api = Pick<LinearApi, "query">;

interface CommentNode {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  url?: unknown;
  parent?: { id?: unknown } | null;
  user?: { id?: unknown; name?: unknown } | null;
  botActor?: unknown;
  issue?: { id?: unknown; identifier?: unknown; title?: unknown; url?: unknown } | null;
}

/** A polled event, with the time that moves the cursor. */
export interface PolledEvent {
  /** Stable per event, for "ran once" across polls and restarts. */
  key: string;
  createdAtMs: number;
  payload: LinearWebhookPayload;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Comments created after `sinceIso`, oldest first, as webhook `Comment` payloads. */
export async function pollComments(api: Api, sinceIso: string): Promise<PolledEvent[]> {
  const out: PolledEvent[] = [];
  let after: string | null = null;
  for (let page = 0; page < LINEAR_POLL_MAX_PAGES; page++) {
    const data = (await api.query(COMMENTS_QUERY, { since: sinceIso, after })) as {
      comments?: { nodes?: CommentNode[]; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
    };
    for (const node of data.comments?.nodes ?? []) {
      const event = commentEvent(node);
      if (event) out.push(event);
    }
    const info = data.comments?.pageInfo;
    after = info?.hasNextPage === true ? (str(info.endCursor) ?? null) : null;
    if (after === null) break;
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function commentEvent(node: CommentNode): PolledEvent | null {
  const id = str(node.id);
  const issueId = str(node.issue?.id);
  const createdAtMs = Date.parse(str(node.createdAt) ?? "");
  if (!id || !issueId || typeof node.body !== "string" || !Number.isFinite(createdAtMs)) return null;
  const userId = str(node.user?.id);
  const userName = str(node.user?.name);
  const identifier = str(node.issue?.identifier);
  const title = str(node.issue?.title);
  const url = str(node.url) ?? str(node.issue?.url);
  return {
    key: `comment:${id}`,
    createdAtMs,
    payload: {
      type: "Comment",
      action: "create",
      webhookTimestamp: createdAtMs,
      ...(url ? { url } : {}),
      ...(userId ? { actor: { id: userId, ...(userName ? { name: userName } : {}), type: "user" } } : {}),
      data: {
        id,
        body: node.body,
        issueId,
        ...(userId ? { userId } : {}),
        parentId: str(node.parent?.id) ?? null,
        ...(node.botActor !== null && node.botActor !== undefined ? { botActor: node.botActor } : {}),
        issue: { id: issueId, ...(identifier ? { identifier } : {}), ...(title ? { title } : {}) },
      },
    },
  };
}

interface IssueNode {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  history?: { nodes?: Array<{ createdAt?: unknown; actorId?: unknown; fromAssigneeId?: unknown; toAssigneeId?: unknown }> };
}

/**
 * Assignments to `viewerId` after `sinceIso`, as webhook `Issue` update
 * payloads: `actor` is whoever assigned it and `updatedFrom.assigneeId`
 * the previous assignee, the two things the handler checks.
 */
export async function pollAssignments(api: Api, viewerId: string, sinceIso: string): Promise<PolledEvent[]> {
  const data = (await api.query(ASSIGNED_QUERY, { viewer: viewerId, since: sinceIso })) as {
    issues?: { nodes?: IssueNode[] };
  };
  const sinceMs = Date.parse(sinceIso);
  const out: PolledEvent[] = [];
  for (const issue of data.issues?.nodes ?? []) {
    const id = str(issue.id);
    if (!id) continue;
    for (const entry of issue.history?.nodes ?? []) {
      const createdAtMs = Date.parse(str(entry.createdAt) ?? "");
      if (entry.toAssigneeId !== viewerId || !Number.isFinite(createdAtMs) || createdAtMs <= sinceMs) continue;
      const actorId = str(entry.actorId);
      const url = str(issue.url);
      out.push({
        key: `assign:${id}:${createdAtMs}`,
        createdAtMs,
        payload: {
          type: "Issue",
          action: "update",
          webhookTimestamp: createdAtMs,
          ...(url ? { url } : {}),
          ...(actorId ? { actor: { id: actorId } } : {}),
          updatedFrom: { assigneeId: str(entry.fromAssigneeId) ?? null },
          data: {
            id,
            assigneeId: viewerId,
            ...(str(issue.identifier) ? { identifier: str(issue.identifier) } : {}),
            ...(str(issue.title) ? { title: str(issue.title) } : {}),
            ...(typeof issue.description === "string" ? { description: issue.description } : {}),
          },
        },
      });
    }
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}
