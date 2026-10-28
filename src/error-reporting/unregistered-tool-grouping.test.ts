import { describe, expect, it } from "vitest";

import { ToolExecutionError } from "../llm/index.js";
import { scrubError } from "./error-scrubber.js";
import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope, UNREGISTERED_TOOL_DISCRIMINATOR } from "./sentry-envelope.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "1.2.3", platform: "darwin" };

function payloadOf(err: Error): { tags: Record<string, string>; fingerprint: string[] } {
  const ev = scrubError(err, { source: "llm_failure", category: "tool" });
  // One fixed frame: the bug is about the discriminator, not the stack.
  ev.frames = [{ filename: "step-unknown-tools.js", lineno: 1 }];
  const body = buildEnvelope(DSN, ev, META).body;
  return JSON.parse(body.trim().split("\n")[2]!);
}

function unregistered(tool: string, nameClass: "near_miss" | "mcp_like" | "other"): ToolExecutionError {
  return new ToolExecutionError(tool, `tool not registered in this agent: ${tool}`, {
    kind: "unregistered",
    nameClass,
  });
}

describe("unregistered-tool error reports", () => {
  it("group as one issue whatever name the model invented", () => {
    const a = payloadOf(unregistered("os.grep", "near_miss"));
    const b = payloadOf(unregistered("mcp.example.toolkit", "mcp_like"));
    const c = payloadOf(unregistered("function_name", "other"));
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(b.fingerprint).toEqual(c.fingerprint);
    expect(a.fingerprint).toEqual([
      "{{ default }}",
      "ToolExecutionError",
      "tool",
      UNREGISTERED_TOOL_DISCRIMINATOR,
      "step-unknown-tools.js",
    ]);
  });

  it("send a bounded name class instead of the invented name", () => {
    const { tags } = payloadOf(unregistered("os.shel.run", "near_miss"));
    expect(tags.tool).toBeUndefined();
    expect(tags.tool_error_kind).toBe("unregistered");
    expect(tags.tool_name_class).toBe("near_miss");
    expect(JSON.stringify(tags)).not.toContain("os.shel.run");
  });

  it("drop a name class outside the enum", () => {
    const err = new ToolExecutionError("x", "m", { kind: "unregistered" });
    (err as { nameClass?: string }).nameClass = "secret words";
    const { tags } = payloadOf(err);
    expect(tags.tool_error_kind).toBe("unregistered");
    expect(tags.tool_name_class).toBeUndefined();
  });

  it("leave an ordinary ToolExecutionError's fingerprint and tool tag unchanged", () => {
    const { tags, fingerprint } = payloadOf(
      new ToolExecutionError("os.shell.run", "aborted while running"),
    );
    expect(tags.tool).toBe("os.shell.run");
    expect(tags.tool_error_kind).toBeUndefined();
    expect(tags.tool_name_class).toBeUndefined();
    expect(fingerprint).toEqual([
      "{{ default }}",
      "ToolExecutionError",
      "tool",
      "os.shell.run",
      "step-unknown-tools.js",
    ]);
  });

  it("ignore a kind outside the enum", () => {
    const err = new ToolExecutionError("os.fs.read", "m");
    (err as { kind?: string }).kind = "made_up";
    const { tags, fingerprint } = payloadOf(err);
    expect(tags.tool).toBe("os.fs.read");
    expect(tags.tool_error_kind).toBeUndefined();
    expect(fingerprint[3]).toBe("os.fs.read");
  });
});
