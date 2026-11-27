import { describe, expect, it } from "vitest";

import { classifyFailureOwner, requestHostIsLocal } from "./failure-owner.js";

describe("classifyFailureOwner (ATO-2419)", () => {
  it.each([
    // The person's own honest refusals from a cloud host.
    ["bad key", 401, "other", "person"],
    ["forbidden", 403, undefined, "person"],
    ["no credit", 402, "out_of_credit", "person"],
    ["model id", 404, "model_not_found", "person"],
    ["plan too small", 413, "request_too_large", "person"],
    ["rate limit", 429, "other", "person"],
    ["Gemini key on a 400", 400, "key_refused", "person"],
    ["OpenAI no quota on a 429", 429, "out_of_credit", "person"],
    // A request we built wrong.
    ["tool result order", 400, "tool_result_missing", "ours"],
    ["roles", 400, "roles_must_alternate", "ours"],
    ["schema", 400, "tool_schema_invalid", "ours"],
    ["empty content", 400, "empty_content", "ours"],
    ["parameter", 422, "unsupported_parameter", "ours"],
    // The provider's trouble.
    ["server error", 500, "other", "provider"],
    ["overloaded", 529, undefined, "provider"],
    ["timeout", 408, undefined, "provider"],
    // Nothing provable.
    ["unknown wording", 400, "other", "unknown"],
    ["no body", 400, undefined, "unknown"],
    ["model without tools", 400, "tools_unsupported", "unknown"],
  ] as const)("%s", (_label, status, reason, expected) => {
    expect(classifyFailureOwner(status, reason, false)).toBe(expected);
  });

  it("does not guess the owner of a 401/403 from a server on this machine", () => {
    // The managed engine refusing our own key, or a server the person
    // started with a key: the status cannot tell which.
    expect(classifyFailureOwner(401, undefined, true)).toBe("unknown");
    expect(classifyFailureOwner(403, "key_refused", true)).toBe("unknown");
    // Any other local refusal is read as usual.
    expect(classifyFailureOwner(400, "tool_result_missing", true)).toBe("ours");
    expect(classifyFailureOwner(404, undefined, true)).toBe("person");
  });

  it("names no owner without an HTTP error status", () => {
    expect(classifyFailureOwner(undefined, undefined, false)).toBeUndefined();
    expect(classifyFailureOwner(200, "other", false)).toBeUndefined();
  });
});

describe("requestHostIsLocal", () => {
  it("reads the first url on the cause chain", () => {
    const local = Object.assign(new Error("wrapper"), {
      cause: Object.assign(new Error("inner"), { url: "http://127.0.0.1:9931/v1/chat/completions" }),
    });
    const cloud = Object.assign(new Error("wrapper"), {
      url: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(requestHostIsLocal(local)).toBe(true);
    expect(requestHostIsLocal(cloud)).toBe(false);
    expect(requestHostIsLocal(new Error("no url"))).toBe(false);
  });
});
