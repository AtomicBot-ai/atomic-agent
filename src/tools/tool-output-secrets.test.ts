import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compressToolResult,
  fullToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import { ToolRegistry, type ToolContext } from "./tool-registry.js";
import { FULL_OUTPUT_PATH_DETAIL, ToolOutputSpill } from "./tool-output-spill.js";
import { maskResultSecrets } from "./tool-output-secrets.js";
import { untrustedContentNote } from "./untrusted-tool-output.js";

// Assembled from parts so no complete key-shaped literal is in the source.
const OPENROUTER = "sk-or-" + "v1-" + "0123456789abcdef".repeat(4);
const OWN_KEY = "Zq9xVv81LmNbTt42";
const ENV_FILE = `OPENROUTER_API_KEY=${OPENROUTER}\nLOG_LEVEL=debug`;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: "/tmp", sessionId: "s", stepIndex: 0, signal: new AbortController().signal, ...over };
}

function shellResult(output: string, maxSummaryLength?: number): CompressedToolResult {
  return compressToolResult(
    { tool: "os.shell.run", status: "ok", output },
    maxSummaryLength === undefined ? {} : { maxSummaryLength },
  );
}

function registryWith(
  run: () => Promise<CompressedToolResult>,
  options: ConstructorParameters<typeof ToolRegistry>[0] = { knownSecrets: () => [] },
  name = "os.shell.run",
  untrustedOutput?: string,
): ToolRegistry {
  const registry = new ToolRegistry(options);
  registry.register({
    name,
    description: "",
    readonly: true,
    ...(untrustedOutput !== undefined ? { untrustedOutput } : {}),
    run,
  });
  return registry;
}

describe("maskResultSecrets (ATO-1077)", () => {
  it("masks the summary and the kept full output", () => {
    const result = shellResult(`${"line\n".repeat(50)}${ENV_FILE}`, 40);
    const masked = maskResultSecrets(result);
    expect(masked.fullOutput).toContain("OPENROUTER_API_KEY=[redacted:openrouter-key]");
    expect(masked.fullOutput).not.toContain(OPENROUTER);
    expect(JSON.stringify(masked)).not.toContain(OPENROUTER);
    // Promoting the full output (cloud mode) keeps the marker.
    expect(fullToolResult(masked).summary).not.toContain(OPENROUTER);
    // The kept copy stays non-enumerable, so local serialization is unchanged.
    expect(Object.keys(masked)).not.toContain("fullOutput");
  });

  it("returns the result itself when there is nothing to mask", () => {
    const result = shellResult("exit: 0\nall good");
    expect(maskResultSecrets(result)).toBe(result);
  });
});

describe("ToolRegistry.invoke masks secrets in every tool's output", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-mask-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("masks a plain local result, without untrusted framing", async () => {
    const registry = registryWith(async () => shellResult(ENV_FILE));
    const out = await registry.invoke("os.shell.run", {}, ctx());
    expect(out.summary).toContain("OPENROUTER_API_KEY=[redacted:openrouter-key]");
    expect(out.summary).toContain("LOG_LEVEL=debug");
    expect(out.summary).not.toContain(OPENROUTER);
  });

  it("masks the promoted full output in cloud mode", async () => {
    const registry = registryWith(async () => shellResult(`${"line\n".repeat(50)}${ENV_FILE}`, 40));
    const out = await registry.invoke("os.shell.run", {}, ctx({ modelMode: "cloud" }));
    expect(out.summary).toContain("[redacted:openrouter-key]");
    expect(out.summary).not.toContain(OPENROUTER);
  });

  it("writes the marker, not the key, to the local spill file", async () => {
    const output = `${Array.from({ length: 200 }, (_, i) => `log line ${i}`).join("\n")}\n${ENV_FILE}`;
    const registry = registryWith(async () => shellResult(output), {
      outputSpill: new ToolOutputSpill({ baseDir: base }),
      knownSecrets: () => [],
    });
    const out = await registry.invoke("os.shell.run", {}, ctx());
    const path = out.details[FULL_OUTPUT_PATH_DETAIL];
    expect(typeof path).toBe("string");
    const saved = readFileSync(path as string, "utf8");
    expect(saved).toContain("OPENROUTER_API_KEY=[redacted:openrouter-key]");
    expect(saved).not.toContain(OPENROUTER);
  });

  it("masks and frames an untrusted tool's output", async () => {
    const registry = registryWith(
      async () => ({ tool: "page", status: "ok", summary: `leaked ${OPENROUTER}`, details: {}, truncated: false }),
      { knownSecrets: () => [] },
      "page",
      "a web page",
    );
    const out = await registry.invoke("page", {}, ctx());
    expect(out.summary).toBe(`${untrustedContentNote("a web page")}\nleaked [redacted:openrouter-key]`);
  });

  it("masks the exact values it is told the agent owns", async () => {
    const registry = registryWith(async () => shellResult(`config dump: ${OWN_KEY}`), {
      knownSecrets: () => [{ label: "openrouter-key", value: OWN_KEY }],
    });
    const out = await registry.invoke("os.shell.run", {}, ctx());
    expect(out.summary).toContain("config dump: [redacted:openrouter-key]");
  });

  it("reads the agent's own secrets from process.env by default", async () => {
    process.env.ATO1077_TEST_API_KEY = OWN_KEY;
    try {
      const registry = new ToolRegistry();
      registry.register({ name: "os.shell.run", description: "", readonly: true, run: async () => shellResult(`value ${OWN_KEY}`) });
      const out = await registry.invoke("os.shell.run", {}, ctx());
      expect(out.summary).toContain("value [redacted:ATO1077_TEST_API_KEY]");
    } finally {
      delete process.env.ATO1077_TEST_API_KEY;
    }
  });

  it("masks a key in a thrown error's message and keeps the error itself", async () => {
    class ProviderError extends Error {}
    const thrown = new ProviderError(`401 for key ${OPENROUTER}`);
    const registry = registryWith(async () => {
      throw thrown;
    });
    const caught = await registry.invoke("os.shell.run", {}, ctx()).catch((err: unknown) => err);
    expect(caught).toBe(thrown);
    expect((caught as Error).message).toBe("401 for key [redacted:openrouter-key]");
  });

  it("leaves the terminal tools' own text alone", async () => {
    const text = `your key starts with ${OPENROUTER}`;
    const registry = registryWith(
      async () => ({ tool: "reply", status: "ok", summary: text, details: {}, truncated: false }),
      { knownSecrets: () => [] },
      "reply",
    );
    expect((await registry.invoke("reply", {}, ctx())).summary).toBe(text);
  });

  it("leaves ordinary output unchanged", async () => {
    const output = "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39\nid 550e8400-e29b-41d4-a716-446655440000\nexit: 0";
    const result = shellResult(output);
    const registry = registryWith(async () => result);
    expect(await registry.invoke("os.shell.run", {}, ctx())).toBe(result);
  });
});
