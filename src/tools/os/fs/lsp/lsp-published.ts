/**
 * What a language server last published per file, kept for `@problems`
 * (ATO-2472). Servers publish for the files they look at, waited for
 * or not; `lsp-client.ts` hands every publish here. An empty list means
 * the file is clean and removes it. Bounded: past MAX_PUBLISHED_FILES the
 * file published longest ago goes first.
 */
import { fileURLToPath } from "node:url";
import type { LspDiagnostic } from "./lsp-delta.js";

/** One file's diagnostics as the server last published them. */
export interface PublishedDiagnostics {
  /** Absolute path of the file. */
  readonly path: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

/** Most files whose published diagnostics are kept. */
export const MAX_PUBLISHED_FILES = 2000;

/** Path of a `file:` URI, or null for any other scheme. */
export function filePathOf(uri: string): string | null {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

export class PublishedDiagnosticsStore {
  private readonly byKey = new Map<string, PublishedDiagnostics>();

  constructor(private readonly max: number = MAX_PUBLISHED_FILES) {}

  /** `key` is the compared URI (`uriKey`), `uri` the one the server sent. */
  remember(key: string, uri: string, diagnostics: readonly LspDiagnostic[]): void {
    this.byKey.delete(key);
    const path = filePathOf(uri);
    if (path === null || diagnostics.length === 0) return;
    this.byKey.set(key, { path, diagnostics });
    if (this.byKey.size > this.max) {
      const oldest = this.byKey.keys().next().value;
      if (oldest !== undefined) this.byKey.delete(oldest);
    }
  }

  list(): readonly PublishedDiagnostics[] {
    return [...this.byKey.values()];
  }
}
