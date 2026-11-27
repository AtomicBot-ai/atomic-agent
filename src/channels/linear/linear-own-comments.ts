/**
 * Loop guard for the Linear channel (ATO-2324): remembers the comments
 * this channel posted so their webhook echo never starts another turn.
 *
 * Two keys, because the echo can arrive before `commentCreate` returns
 * the new id: the body is recorded before the post goes out, the id once
 * Linear answers. Both are capped so a long-running channel does not
 * grow without bound. A comment matches by id, or by exact (trimmed)
 * body when its author is the API key's own user.
 */

const CAP = 200;

export class LinearOwnComments {
  private readonly ids = new Set<string>();
  private readonly bodies = new Set<string>();

  /** Call before posting `body`. */
  notePending(body: string): void {
    add(this.bodies, body.trim());
  }

  /** Call once Linear returned the new comment's id. */
  notePosted(id: string): void {
    add(this.ids, id);
  }

  /**
   * True when the comment is one of ours. `byViewer` says whether its
   * author is the user the API key acts as: only then can a body match.
   */
  isOwn(id: string, body: string, byViewer: boolean): boolean {
    if (this.ids.has(id)) return true;
    if (!byViewer) return false;
    const key = body.trim();
    if (!this.bodies.has(key)) return false;
    this.bodies.delete(key);
    add(this.ids, id);
    return true;
  }
}

function add(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= CAP) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) set.delete(oldest);
}
