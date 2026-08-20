import { describe, expect, it } from "vitest";

import { codexCliAdapter } from "./codex-cli-adapter.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
} from "./subscription-cli-errors.js";

const input = { model: "", systemPrompt: "SYSTEM", extraArgs: [] as readonly string[] };

/** Captured verbatim from `codex exec --json` v0.148.0. */
const SUCCESS = [
  JSON.stringify({ type: "thread.started", thread_id: "01a0" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "OK" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 13459,
      cached_input_tokens: 5888,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 27,
    },
  }),
].join("\n");

describe("codexCliAdapter argv", () => {
  it("runs exec headless, sandboxed, and stateless", () => {
    const args = codexCliAdapter.completeArgs(input);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ignore-user-config");
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual([
      "-s",
      "read-only",
    ]);
    // Trailing `-` is what makes Codex read the prompt from stdin.
    expect(args[args.length - 1]).toBe("-");
  });

  it("omits -m entirely when no model is configured", () => {
    // Verified live: under a ChatGPT login Codex rejects every explicit
    // model id and resolves one server-side.
    expect(codexCliAdapter.completeArgs(input)).not.toContain("-m");
    expect(codexCliAdapter.defaultChatModel).toBe("");
    expect(codexCliAdapter.staticModels).toEqual([]);
  });

  it("passes an operator-chosen model when one is set", () => {
    const args = codexCliAdapter.completeArgs({ ...input, model: "gpt-5.1" });
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1");
  });

  it("takes the schema as a file path, never inline", () => {
    expect(codexCliAdapter.schemaDelivery).toBe("file");
    const args = codexCliAdapter.completeArgs({
      ...input,
      responseSchemaPath: "/tmp/s/schema.json",
    });
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/s/schema.json");
    expect(args).not.toContain("--json-schema");
  });

  it("never passes the dangerous escape hatches", () => {
    const args = codexCliAdapter.completeArgs({
      ...input,
      extraArgs: ["--enable", "x"],
    });
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--dangerously-bypass-hook-trust");
    expect(args).not.toContain("--add-dir");
  });

  it("carries the steering in stdin, since codex has no system-prompt flag", () => {
    const stdin = codexCliAdapter.buildStdin("PROMPT", "SYSTEM");
    expect(stdin).toBe("SYSTEM\n\nPROMPT");
    expect(codexCliAdapter.completeArgs(input)).not.toContain("--system-prompt");
  });
});

describe("codexCliAdapter parseResult", () => {
  it("maps the real success stream", () => {
    const result = codexCliAdapter.parseResult(SUCCESS, "");
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("stop");
    expect(result.slotId).toBe(-1);
    // cached_input_tokens is a subset of input_tokens here, unlike
    // Claude's disjoint counters, so it is reported and not added.
    expect(result.usage).toEqual({
      promptTokens: 13459,
      completionTokens: 5 + 27,
      totalTokens: 13459 + 32,
    });
    expect(result.cacheHitTokens).toBe(5888);
  });

  it("throws on turn.failed even though codex exits 0", () => {
    // The whole reason this parser cannot trust the exit code.
    const failed = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "The 'x' model is not supported when using Codex with a ChatGPT account." },
      }),
    ].join("\n");
    expect(() => codexCliAdapter.parseResult(failed, "")).toThrow(
      SubscriptionCliInvocationError,
    );
    expect(() => codexCliAdapter.parseResult(failed, "")).toThrow(
      /not supported when using Codex/,
    );
  });

  it("treats a stream with no turn.completed as a failure, not empty content", () => {
    expect(() =>
      codexCliAdapter.parseResult(
        JSON.stringify({ type: "thread.started" }),
        "",
      ),
    ).toThrow(/no turn.completed/);
  });

  it("classifies a signed-out failure as an auth error", () => {
    const failed = JSON.stringify({
      type: "turn.failed",
      error: { message: "401 Unauthorized" },
    });
    expect(() => codexCliAdapter.parseResult(failed, "")).toThrow(
      SubscriptionCliAuthError,
    );
  });

  it("ignores the non-fatal metadata warning when the turn still completes", () => {
    const withWarning = [
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "Model metadata not found" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "fine" },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    expect(codexCliAdapter.parseResult(withWarning, "").content).toBe("fine");
  });

  it("ignores malformed lines rather than failing the turn", () => {
    const noisy = `not json\n${SUCCESS}\n\n`;
    expect(codexCliAdapter.parseResult(noisy, "").content).toBe("OK");
  });
});
