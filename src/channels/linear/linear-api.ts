/**
 * Outbound Linear GraphQL calls for the Linear channel (ATO-2324): who
 * the API key belongs to (`viewer`, for the self-comment loop guard) and
 * `commentCreate` for replies. Plain `fetch`, no `@linear/sdk`: two
 * queries do not justify a client SDK in a single-file binary.
 *
 * Auth follows Linear's docs: a personal API key (`lin_api_...`) is sent
 * as the bare `Authorization` value, an OAuth access token as
 * `Bearer <token>`. The key is never put in an error message.
 */

import { LINEAR_COMMENT_LIMIT, LINEAR_GRAPHQL_URL, type LinearTarget } from "./linear-types.js";

export class LinearApiError extends Error {
  constructor(
    message: string,
    /** `auth` (key refused), `http_<status>`, `graphql`, `bad_response`. */
    readonly code: string,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

export interface LinearViewer {
  id: string;
  name: string;
}

export interface LinearApiDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  url?: string;
}

const VIEWER_QUERY = "query AtomicAgentViewer { viewer { id name } }";
const COMMENT_CREATE_MUTATION =
  "mutation AtomicAgentCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }";

export function linearAuthHeader(apiKey: string): string {
  return apiKey.startsWith("lin_api_") ? apiKey : `Bearer ${apiKey}`;
}

/** Cut a reply that would not fit one comment, saying so. */
export function fitCommentBody(text: string, limit = LINEAR_COMMENT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = "\n\n(Reply cut: it was longer than one Linear comment.)";
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`;
}

export class LinearApi {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly deps: LinearApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.url = deps.url ?? LINEAR_GRAPHQL_URL;
  }

  /** The user (or app) the API key acts as. Rejects when the key is refused. */
  async viewer(): Promise<LinearViewer> {
    const data = await this.request(VIEWER_QUERY, {});
    const viewer = (data as { viewer?: { id?: unknown; name?: unknown } }).viewer;
    if (typeof viewer?.id !== "string") throw new LinearApiError("Linear returned no viewer", "bad_response");
    return { id: viewer.id, name: typeof viewer.name === "string" ? viewer.name : "" };
  }

  /**
   * Post `body` as a comment on the issue, inside the thread of
   * `target.parentId` when set. Returns the new comment's id.
   */
  async createComment(target: LinearTarget, body: string): Promise<string> {
    const input: Record<string, string> = { issueId: target.issueId, body: fitCommentBody(body) };
    if (target.parentId) input.parentId = target.parentId;
    const data = await this.request(COMMENT_CREATE_MUTATION, { input });
    const result = (data as { commentCreate?: { success?: unknown; comment?: { id?: unknown } } }).commentCreate;
    if (result?.success !== true || typeof result.comment?.id !== "string") {
      throw new LinearApiError("Linear did not create the comment", "bad_response");
    }
    return result.comment.id;
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearAuthHeader(this.deps.apiKey),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    let json: GraphqlBody | null = null;
    try {
      json = (await res.json()) as GraphqlBody | null;
    } catch {
      json = null;
    }
    if (res.status === 401 || res.status === 403 || isAuthError(json)) {
      throw new LinearApiError(`Linear refused the API key (HTTP ${res.status})`, "auth");
    }
    if (!res.ok) {
      throw new LinearApiError(`Linear API answered HTTP ${res.status}${firstError(json)}`, `http_${res.status}`);
    }
    if (json?.errors && json.errors.length > 0) {
      throw new LinearApiError(`Linear API error${firstError(json)}`, "graphql");
    }
    if (json?.data === undefined || json.data === null) {
      throw new LinearApiError("Linear API returned no data", "bad_response");
    }
    return json.data;
  }
}

interface GraphqlBody {
  data?: unknown;
  errors?: Array<{ message?: unknown; extensions?: { code?: unknown } }>;
}

/** Linear answers a bad key with HTTP 400 and `extensions.code: AUTHENTICATION_ERROR`. */
function isAuthError(json: GraphqlBody | null): boolean {
  return json?.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR") === true;
}

function firstError(json: GraphqlBody | null): string {
  const message = json?.errors?.[0]?.message;
  return typeof message === "string" && message.length > 0 ? `: ${message.slice(0, 200)}` : "";
}
