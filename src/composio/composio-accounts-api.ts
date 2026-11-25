/**
 * List the connected accounts Composio holds for this install's user id.
 *
 * `GET /connected_accounts?user_ids=…` returns every account the user
 * connected through any session, across toolkits. It is what a picker
 * shows next to each local alias, and how a second account connected
 * through `COMPOSIO_MANAGE_CONNECTIONS` becomes visible so it can be
 * given an alias (see `composio-accounts.ts`).
 *
 * Only the fields the agent needs are kept. Credentials never appear in
 * this response for an API-key caller, and nothing from `state` past
 * the provider's display name (an e-mail or login) is read.
 */

import {
  ComposioApiError,
  composioRequest,
  type ComposioRequestOptions,
} from "./composio-api.js";

export interface ComposioConnectedAccount {
  /** Connected account id, `ca_…`. */
  id: string;
  /** Toolkit slug, lowercase. */
  toolkit: string;
  /** `ACTIVE`, `INITIATED`, `EXPIRED`, … as Composio reports it. */
  status: string;
  /** Alias set on Composio's side, if any. Not the local alias. */
  alias: string | null;
  /** Provider-side identity (an e-mail, a login) once active. */
  displayName: string | null;
  /** ISO creation time. */
  createdAt: string | null;
}

export interface ListConnectedAccountsOptions extends ComposioRequestOptions {
  userId: string;
  /** Narrow to one toolkit slug. */
  toolkit?: string;
  /** Default: only `ACTIVE` accounts. Pass `[]` for every status. */
  statuses?: readonly string[];
}

/** A hard stop on pagination, so a broken cursor cannot loop forever. */
const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

export async function listComposioConnectedAccounts(
  opts: ListConnectedAccountsOptions,
): Promise<ComposioConnectedAccount[]> {
  const out: ComposioConnectedAccount[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams();
    query.append("user_ids", opts.userId);
    if (opts.toolkit !== undefined) query.append("toolkit_slugs", opts.toolkit);
    for (const status of opts.statuses ?? ["ACTIVE"]) {
      query.append("statuses", status);
    }
    query.set("limit", String(PAGE_LIMIT));
    if (cursor !== null) query.set("cursor", cursor);
    const body = await composioRequest(
      opts,
      `/connected_accounts?${query.toString()}`,
      { method: "GET" },
    );
    const parsed = parseConnectedAccountsPage(body);
    out.push(...parsed.items);
    cursor = parsed.nextCursor;
    if (cursor === null) break;
  }
  return out;
}

/** Narrow one page of the listing. Malformed items are skipped. */
export function parseConnectedAccountsPage(body: unknown): {
  items: ComposioConnectedAccount[];
  nextCursor: string | null;
} {
  if (typeof body !== "object" || body === null) {
    throw new ComposioApiError(
      "Composio returned a non-object connected accounts body.",
      0,
    );
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.items)) {
    throw new ComposioApiError(
      "Composio connected accounts response carried no items.",
      0,
    );
  }
  const items: ComposioConnectedAccount[] = [];
  for (const raw of obj.items) {
    const item = parseItem(raw);
    if (item !== undefined) items.push(item);
  }
  const next = obj.next_cursor;
  return {
    items,
    nextCursor: typeof next === "string" && next.length > 0 ? next : null,
  };
}

function parseItem(raw: unknown): ComposioConnectedAccount | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const toolkit = (o.toolkit as Record<string, unknown> | undefined)?.slug;
  if (typeof o.id !== "string" || o.id.length === 0) return undefined;
  if (typeof toolkit !== "string" || toolkit.length === 0) return undefined;
  const state = o.state as Record<string, unknown> | undefined;
  const val = state?.val as Record<string, unknown> | undefined;
  return {
    id: o.id,
    toolkit: toolkit.toLowerCase(),
    status: typeof o.status === "string" ? o.status : "UNKNOWN",
    alias: nonEmpty(o.alias),
    displayName: nonEmpty(val?.displayName),
    createdAt: nonEmpty(o.created_at),
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
