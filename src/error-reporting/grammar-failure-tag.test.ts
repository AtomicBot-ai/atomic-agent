import { describe, expect, it } from "vitest";

import { LlamaServerError } from "../llm/llama-server-client.js";
import { GrammarError, ModelError } from "../llm/reliability/llm-failures.js";
import { scrubError } from "./error-scrubber.js";
import { extractGrammarFailureTags } from "./grammar-failure-tag.js";
import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope, buildFingerprint } from "./sentry-envelope.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "1.2.3", platform: "darwin" };

function tagsOf(err: Error): Record<string, string> {
  const ev = scrubError(err, { source: "llm_failure", category: "grammar" });
  const body = buildEnvelope(DSN, ev, META).body;
  return (JSON.parse(body.trim().split("\n")[2]!) as { tags: Record<string, string> }).tags;
}

const refusal = new LlamaServerError(
  "llama-server returned http 400: Failed to parse grammar",
  400,
  "http://127.0.0.1:9931/completion",
);

describe("grammar_path and grammar_skipped tags (ATO-2422)", () => {
  it("names a server refusal of the grammar, with no grammar_skipped", () => {
    const err = new GrammarError(refusal.message, "", { cause: refusal, path: "server_refused_grammar" });
    expect(extractGrammarFailureTags(err)).toEqual({ grammar_path: "server_refused_grammar" });
    const tags = tagsOf(err);
    expect(tags.grammar_path).toBe("server_refused_grammar");
    expect(tags.grammar_skipped).toBeUndefined();
    expect(tags.http_status).toBe("400");
  });

  it("says whether a failed repair was served without the grammar, and which transport", () => {
    const skipped = new GrammarError("bad", "{", { path: "repair_failed", transport: "grammar", grammarSkipped: true });
    expect(tagsOf(skipped)).toMatchObject({ grammar_path: "repair_failed", grammar_skipped: "yes", tool_transport: "grammar" });
    const native = new GrammarError("bad", "{", { path: "repair_failed", transport: "native_tools" });
    expect(tagsOf(native)).toMatchObject({ grammar_path: "repair_failed", grammar_skipped: "no", tool_transport: "native_tools" });
  });

  it("finds the GrammarError under a wrapper", () => {
    const inner = new GrammarError("bad", "", { path: "parse_failed" });
    const outer = new Error("turn failed", { cause: inner });
    expect(extractGrammarFailureTags(outer)).toEqual({ grammar_path: "parse_failed" });
  });

  it("sends nothing for an untagged GrammarError or another error class", () => {
    expect(extractGrammarFailureTags(new GrammarError("bad", ""))).toBeUndefined();
    expect(extractGrammarFailureTags(new ModelError("empty", "model returned empty content"))).toBeUndefined();
    expect(tagsOf(new GrammarError("bad", "")).grammar_path).toBeUndefined();
  });

  it("drops a path outside the vocabulary", () => {
    const forged = Object.assign(new GrammarError("bad", ""), { path: "/Users/someone/notes.md" });
    expect(extractGrammarFailureTags(forged)).toBeUndefined();
  });

  it("leaves the fingerprint as it was", () => {
    const plain = scrubError(new GrammarError("bad", "", { cause: refusal }), { source: "llm_failure" });
    const tagged = scrubError(
      new GrammarError("bad", "", { cause: refusal, path: "server_refused_grammar" }),
      { source: "llm_failure" },
    );
    expect(buildFingerprint(tagged)).toEqual(buildFingerprint(plain));
  });
});
