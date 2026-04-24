import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Flat-file store mapping webhook names to the session id they
 * persistently reuse across hits. Kept deliberately tiny — just
 * `<name>: <sessionId>` on disk — because the volume is bounded by the
 * operator's config and we want the persistence format to be
 * human-editable for recovery scenarios.
 *
 * Concurrency: all writes are synchronous through the single HTTP
 * server process, and we reread on every get so operators can hot-swap
 * entries by editing the file. A corrupt/missing file resets to an
 * empty map rather than failing the whole webhook pipeline.
 */
export class WebhookSessionStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get(name: string): string | null {
    const map = this.readMap();
    const value = map[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /**
   * Persist a webhook name -> sessionId binding. Overwrites any
   * existing entry. Callers create the session upstream via
   * `AgentRuntime.createSession` — this store only remembers the id.
   */
  set(name: string, sessionId: string): void {
    const map = this.readMap();
    map[name] = sessionId;
    this.writeMap(map);
  }

  delete(name: string): void {
    const map = this.readMap();
    if (!(name in map)) return;
    delete map[name];
    this.writeMap(map);
  }

  private readMap(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value.length > 0) {
          out[key] = value;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeMap(map: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }
}
