import { describe, it, expect } from "vitest";

import { renderWebhookTemplate } from "./webhook-template.js";

describe("renderWebhookTemplate", () => {
  it("substitutes top-level string fields", () => {
    const out = renderWebhookTemplate("hello {{body.name}}", { name: "magos" });
    expect(out).toBe("hello magos");
  });

  it("traverses nested paths", () => {
    const out = renderWebhookTemplate(
      "repo={{body.repository.full_name}}",
      { repository: { full_name: "atomicbot/atomic-agent" } },
    );
    expect(out).toBe("repo=atomicbot/atomic-agent");
  });

  it("substitutes numbers and booleans as their string form", () => {
    const out = renderWebhookTemplate(
      "count={{body.count}} ok={{body.ok}}",
      { count: 42, ok: true },
    );
    expect(out).toBe("count=42 ok=true");
  });

  it("serializes objects and arrays via JSON.stringify", () => {
    const out = renderWebhookTemplate("payload={{body.data}}", {
      data: { a: 1, b: [2, 3] },
    });
    expect(out).toBe(`payload={"a":1,"b":[2,3]}`);
  });

  it("returns empty for missing paths", () => {
    const out = renderWebhookTemplate("hello {{body.missing.path}}", {
      other: 1,
    });
    expect(out).toBe("hello ");
  });

  it("returns empty for non-body prefixes", () => {
    const out = renderWebhookTemplate("{{env.FOO}}", {});
    expect(out).toBe("");
  });

  it("respects an escape prefix", () => {
    const out = renderWebhookTemplate("literal \\{{body.name}}", {
      name: "x",
    });
    expect(out).toBe("literal {{body.name}}");
  });
});
