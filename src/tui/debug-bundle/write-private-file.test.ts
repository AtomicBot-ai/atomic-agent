import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePrivateFile } from "./write-private-file.js";
import { writeDebugBundleZip } from "./write-debug-zip.js";
import type { DebugBundleSnapshot } from "./build-snapshot.js";

const posix = process.platform !== "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "private-file-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe.skipIf(!posix)("writePrivateFile (ATO-1179)", () => {
  it("creates the file owner-only", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "a.zip");
      await writePrivateFile(path, Buffer.from("payload"));
      expect(modeOf(path)).toBe(0o600);
      expect(await readFile(path, "utf8")).toBe("payload");
    });
  });

  it("narrows an existing world-readable file", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "b.zip");
      writeFileSync(path, "old");
      chmodSync(path, 0o644);
      await writePrivateFile(path, "new");
      expect(modeOf(path)).toBe(0o600);
    });
  });

  it("debug bundle zip lands as -rw-------", async () => {
    await withTmp(async (root) => {
      const snapshot = {
        session: { sessionId: null, workingDir: "/tmp/work" },
      } as unknown as DebugBundleSnapshot;
      const result = await writeDebugBundleZip({
        snapshot,
        traceDir: join(root, "traces"),
        traceEnabled: false,
        sessionIds: [],
        outDir: join(root, "out"),
      });
      expect(modeOf(result.path)).toBe(0o600);
    });
  });
});
