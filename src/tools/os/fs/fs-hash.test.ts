import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ToolContext } from "../../tool-registry.js";
import { osFsHashTool } from "./fs-hash.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs.hash", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-hash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("computes SHA-256 by default", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "hello omnissiah", "utf8");
    const expected = createHash("sha256")
      .update("hello omnissiah")
      .digest("hex");
    const result = await osFsHashTool.run({ path: "a.txt" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.digest).toBe(expected);
    expect(result.details.algorithm).toBe("sha256");
    expect(result.summary).toContain(expected);
  });

  it("honours an explicit algorithm", async () => {
    const path = join(dir, "b.txt");
    await writeFile(path, "magos", "utf8");
    const md5 = createHash("md5").update("magos").digest("hex");
    const result = await osFsHashTool.run(
      { path: "b.txt", algorithm: "md5" },
      makeCtx(dir),
    );
    expect(result.details.digest).toBe(md5);
  });

  it("supports base64 encoding", async () => {
    const path = join(dir, "c.txt");
    await writeFile(path, "sacred circuit", "utf8");
    const expected = createHash("sha1")
      .update("sacred circuit")
      .digest("base64");
    const result = await osFsHashTool.run(
      { path: "c.txt", algorithm: "sha1", encoding: "base64" },
      makeCtx(dir),
    );
    expect(result.details.digest).toBe(expected);
    expect(result.details.encoding).toBe("base64");
  });

  it("streams a large file without buffering it all", async () => {
    const path = join(dir, "big.bin");
    // 2 MB of deterministic content built from a repeating pattern.
    const chunk = Buffer.alloc(64 * 1024, 0xab);
    const parts: Buffer[] = [];
    for (let i = 0; i < 32; i++) parts.push(chunk);
    const full = Buffer.concat(parts);
    await writeFile(path, full);
    const expected = createHash("sha512").update(full).digest("hex");
    const result = await osFsHashTool.run(
      { path: "big.bin", algorithm: "sha512" },
      makeCtx(dir),
    );
    expect(result.details.digest).toBe(expected);
    expect(result.details.size).toBe(full.length);
  });

  it("rejects an unknown algorithm", async () => {
    const path = join(dir, "x.txt");
    await writeFile(path, "hi", "utf8");
    await expect(
      osFsHashTool.run({ path: "x.txt", algorithm: "whirlpool" }, makeCtx(dir)),
    ).rejects.toThrow(/unknown algorithm/);
  });

  it("rejects when path is a directory", async () => {
    await expect(osFsHashTool.run({ path: "." }, makeCtx(dir))).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("keeps null algorithm and encoding as the existing defaults", async () => {
    await writeFile(join(dir, "null-defaults.txt"), "compatible replay", "utf8");
    const result = await osFsHashTool.run(
      { path: "null-defaults.txt", algorithm: null, encoding: null },
      makeCtx(dir),
    );
    expect(result.details.algorithm).toBe("sha256");
    expect(result.details.encoding).toBe("hex");
    expect(result.details.digest).toBe(createHash("sha256").update("compatible replay").digest("hex"));
  });

  it("normalizes uppercase algorithms without tightening replay args to the wire enum", async () => {
    await writeFile(join(dir, "uppercase.txt"), "existing casing", "utf8");
    const result = await osFsHashTool.run(
      { path: "uppercase.txt", algorithm: "SHA256" },
      makeCtx(dir),
    );
    expect(result.details.algorithm).toBe("sha256");
    expect(result.details.digest).toBe(createHash("sha256").update("existing casing").digest("hex"));
  });

  it("keeps encoding case-sensitive while algorithm accepts uppercase", async () => {
    await expect(osFsHashTool.run(
      { path: "unused.txt", algorithm: "SHA256", encoding: "HEX" },
      makeCtx(dir),
    )).rejects.toMatchObject({
      message: "os.fs.hash: `encoding` must be 'hex' or 'base64'",
    });
  });

  it.each([
    { label: "missing", path: undefined },
    { label: "empty", path: "" },
    { label: "null", path: null },
    { label: "number", path: 42 },
    { label: "array", path: [] },
  ])("rejects a $label path before touching the filesystem", async ({ path }) => {
    await expect(osFsHashTool.run({ path }, makeCtx(dir))).rejects.toMatchObject({
      message: "os.fs.hash: `path` must be a non-empty string",
    });
  });

  it("keeps the algorithm type error separate from an unknown algorithm", async () => {
    await expect(osFsHashTool.run(
      { path: "unused.txt", algorithm: 256 },
      makeCtx(dir),
    )).rejects.toMatchObject({
      message: "os.fs.hash: `algorithm` must be a string",
    });
  });

  it("preserves the unknown algorithm's value and supported set in the error", async () => {
    await expect(osFsHashTool.run(
      { path: "unused.txt", algorithm: "whirlpool" },
      makeCtx(dir),
    )).rejects.toMatchObject({
      message: 'os.fs.hash: unknown algorithm "whirlpool" (supported: md5, sha1, sha256, sha512)',
    });
  });
});
