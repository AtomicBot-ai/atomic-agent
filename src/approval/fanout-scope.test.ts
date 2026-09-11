import { describe, expect, it } from "vitest";
import { FanoutScopeRegistry, isInside } from "./fanout-scope.js";

describe("FanoutScopeRegistry", () => {
  it("allows a path inside a granted directory", () => {
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    expect(reg.allows("s-w-1", ["/tmp/rel-2/cart.js"])).toBe(true);
    expect(reg.allows("s-w-1", ["/tmp/rel-2/deep/nested.js"])).toBe(true);
  });

  it("refuses a path outside it", () => {
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    expect(reg.allows("s-w-1", ["/etc/passwd"])).toBe(false);
    expect(reg.allows("s-w-1", ["/tmp/rel-2-backup/x.js"])).toBe(false);
  });

  it("is all or nothing across a call's paths", () => {
    // A call that writes three files, one of them outside the scope, is
    // not a call the operator authorised.
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    expect(
      reg.allows("s-w-1", ["/tmp/rel-2/a.js", "/tmp/elsewhere/b.js"]),
    ).toBe(false);
  });

  it("never leaks between sessions", () => {
    // Worker sessions each get their own grant deliberately; a parent's
    // authority is not a worker's.
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    expect(reg.allows("s-w-2", ["/tmp/rel-2/cart.js"])).toBe(false);
  });

  it("grants nothing for an empty or relative scope", () => {
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", []);
    expect(reg.allows("s-w-1", ["/tmp/x"])).toBe(false);
    reg.grant("s-w-2", ["relative/dir"]);
    expect(reg.allows("s-w-2", ["/tmp/x"])).toBe(false);
  });

  it("refuses an empty path list", () => {
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    expect(reg.allows("s-w-1", [])).toBe(false);
  });

  it("forgets a session on clear", () => {
    const reg = new FanoutScopeRegistry();
    reg.grant("s-w-1", ["/tmp/rel-2"]);
    reg.clear("s-w-1");
    expect(reg.allows("s-w-1", ["/tmp/rel-2/cart.js"])).toBe(false);
    expect(reg.scopeFor("s-w-1")).toEqual([]);
  });
});

describe("isInside", () => {
  it("counts the directory itself", () => {
    expect(isInside("/tmp/x", "/tmp/x")).toBe(true);
  });

  it("rejects a sibling that merely shares a prefix", () => {
    expect(isInside("/tmp/x", "/tmp/xy")).toBe(false);
  });

  it("rejects a parent", () => {
    expect(isInside("/tmp/x", "/tmp")).toBe(false);
  });
});
