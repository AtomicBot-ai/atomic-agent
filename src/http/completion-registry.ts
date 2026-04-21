/**
 * In-memory registry of running OpenAI chat completions so clients can
 * cancel them via `POST /v1/chat/completions/{id}/cancel`. We only
 * track streaming completions (non-streaming requests already block
 * the single outstanding-turn slot; the client can just drop the
 * connection). Per-id abort is idempotent.
 */
export interface CompletionEntry {
  completionId: string;
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

export class CompletionRegistry {
  private readonly entries = new Map<string, CompletionEntry>();

  register(entry: CompletionEntry): void {
    this.entries.set(entry.completionId, entry);
  }

  unregister(completionId: string): void {
    this.entries.delete(completionId);
  }

  cancel(completionId: string): boolean {
    const entry = this.entries.get(completionId);
    if (!entry) return false;
    entry.controller.abort();
    this.entries.delete(completionId);
    return true;
  }

  has(completionId: string): boolean {
    return this.entries.has(completionId);
  }

  size(): number {
    return this.entries.size;
  }
}
