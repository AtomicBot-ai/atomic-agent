import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Extractor } from "./extractor-types.js";

/**
 * Legacy .doc (Word 97-2003, OLE2 BIFF) extractor backed by the
 * `word-extractor` npm package. We cannot generate .doc binaries from pure
 * JS, so this extractor is tested via dependency-injection at the
 * `createExtractor` boundary; production callers use the exported
 * `docExtractor` which wires the real library.
 *
 * Quirk: word-extractor's API takes a file path rather than a buffer, so
 * we spill the incoming buffer to a temp file and clean it up on the way
 * out. The rename into a deterministic filename is intentional — it lets
 * error messages carry a useful source path while avoiding any PATH
 * injection concern.
 */
export interface DocExtractorClient {
  extract(filePath: string): Promise<{
    getBody(): string;
  }>;
}

export function createDocExtractor(
  loadClient: () => Promise<DocExtractorClient>,
  writeTempFile: (data: Buffer) => Promise<{ path: string; cleanup: () => Promise<void> }>,
): Extractor {
  return async (input) => {
    const warnings: string[] = [];
    const client = await loadClient();
    const temp = await writeTempFile(input.data);
    try {
      const doc = await client.extract(temp.path);
      const raw = doc.getBody();
      const text = raw
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return {
        format: "doc",
        text,
        warnings,
      };
    } finally {
      await temp.cleanup().catch(() => undefined);
    }
  };
}

async function defaultTempWrite(
  data: Buffer,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = join(
    tmpdir(),
    `atomic-agent-doc-${Date.now()}-${Math.random().toString(36).slice(2)}.doc`,
  );
  await writeFile(path, data);
  return {
    path,
    async cleanup() {
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
    },
  };
}

async function defaultLoadClient(): Promise<DocExtractorClient> {
  const mod = (await import("word-extractor")) as
    | { default: new () => DocExtractorClient }
    | (new () => DocExtractorClient);
  const Ctor = "default" in mod ? mod.default : mod;
  return new Ctor();
}

export const docExtractor: Extractor = createDocExtractor(
  defaultLoadClient,
  defaultTempWrite,
);
