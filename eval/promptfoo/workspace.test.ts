import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { check, failures } from "./asserts.mjs";
import {
  buildStateConfig,
  currentConfigVersion,
  resolveTarget,
  seedFiles,
  sessionIdFromStderr,
  snapshotFiles,
  toolCallsFromTrace,
} from "./workspace.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aa-pf-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("promptfoo workspace helpers", () => {
  it("picks llama-server over OpenRouter and null with neither", () => {
    expect(resolveTarget({ PROMPTFOO_AGENT_LLAMA_URL: "http://x:1", OPENROUTER_API_KEY: "k" })).toEqual({ kind: "llama-server", url: "http://x:1" });
    expect(resolveTarget({ OPENROUTER_API_KEY: "k", PROMPTFOO_AGENT_MODEL: "m/x" })).toEqual({ kind: "openrouter", model: "m/x" });
    expect(resolveTarget({})).toBeNull();
  });

  it("writes the current schema version and keeps the key out of config.json", () => {
    expect(currentConfigVersion()).toBeGreaterThan(10);
    const cfg = buildStateConfig({ kind: "openrouter", model: "m/x" }, 79);
    expect(cfg.version).toBe(79);
    expect(cfg.llm.activeTextProvider).toBe("openrouter");
    expect(JSON.stringify(cfg)).not.toMatch(/apiKey|sk-or/);
  });

  it("seeds and snapshots files, refusing paths outside the project", () => {
    const root = temp();
    seedFiles(root, { "a/b.txt": "hi", ".env": "X=1" });
    expect(snapshotFiles(root)).toEqual({ "a/b.txt": "hi", ".env": "X=1" });
    expect(() => seedFiles(root, { "../escape.txt": "no" })).toThrow(/escapes/);
  });

  it("reads the session id and tool calls the run left behind", () => {
    expect(sessionIdFromStderr('log line\n{"sessionId":"s-1","status":"completed"}\n')).toBe("s-1");
    expect(sessionIdFromStderr("no json\n")).toBeNull();
    const trace = join(temp(), "t.ndjson");
    writeFileSync(trace, [
      JSON.stringify({ type: "step_started" }),
      JSON.stringify({ type: "tool_invocation", tool: "os.fs.read", status: "ok", args: { path: "a" } }),
      "not json",
    ].join("\n"));
    expect(toolCallsFromTrace(trace)).toEqual([{ tool: "os.fs.read", status: "ok", args: { path: "a" } }]);
  });
});

describe("promptfoo expectations", () => {
  const run = {
    reply: "The date is 2031-04-12.",
    exitCode: 0,
    timedOut: false,
    tools: [{ tool: "os.fs.read", status: "ok", args: { path: "README.md" } }],
    files: { "README.md": "x", "out.md": "# Changelog" },
  };

  it("passes when every expectation holds", () => {
    expect(failures(run, { reply: ["2031-04-12"], tools: ["os.fs.read"], notTools: ["os.shell.run"], files: ["out.md"], fileMatches: { "out.md": "changelog" }, maxTools: 1 })).toEqual([]);
  });

  it("names each broken expectation", () => {
    const failed = failures({ ...run, exitCode: 1 }, { notReply: ["2031"], notFiles: ["out.md"], notArgs: ["readme"], maxTools: 0 });
    expect(failed).toHaveLength(5);
  });

  it("fails cleanly on output that is not the provider JSON", () => {
    expect(check("plain text", { vars: {} }).pass).toBe(false);
    expect(check(JSON.stringify(run), { vars: { expect: { reply: ["2031"] } } }).pass).toBe(true);
  });
});

describe("promptfooconfig.yaml", () => {
  const config = parse(readFileSync(join(HERE, "promptfooconfig.yaml"), "utf8"));
  const known = new Set(["reply", "notReply", "tools", "notTools", "maxTools", "files", "notFiles", "fileMatches", "notArgs"]);

  it("has the regression set and the injection set", () => {
    expect(config.tests.length).toBeGreaterThanOrEqual(15);
    expect(config.tests.filter((t: { description: string }) => t.description.startsWith("injection:")).length).toBeGreaterThanOrEqual(5);
  });

  it("gives every test a task and only known, compilable expectations", () => {
    for (const test of config.tests) {
      expect(typeof test.vars.task, test.description).toBe("string");
      for (const [key, value] of Object.entries(test.vars.expect ?? {})) {
        expect(known.has(key), `${test.description}: ${key}`).toBe(true);
        const patterns = key === "fileMatches" ? Object.values(value as object) : ["reply", "notReply", "notArgs"].includes(key) ? (value as string[]) : [];
        for (const pattern of patterns) expect(() => new RegExp(pattern as string, "i")).not.toThrow();
      }
    }
  });
});
