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
describe("the turn-scoped grant", () => {
  it("answers for every later fan-out of the same turn", () => {
    const scopes = new FanoutScopeRegistry();
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel"])).toBe(false);
    scopes.grantForTurn("s-1", ["/tmp/rel"]);
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel"])).toBe(true);
    // Deeper inside the same directory is the same permission — this is
    // the review pass re-delegating into a subfolder it just read.
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel/src"])).toBe(true);
  });

  it("asks again for a directory nobody approved", () => {
    const scopes = new FanoutScopeRegistry();
    scopes.grantForTurn("s-1", ["/tmp/rel"]);
    expect(scopes.turnGrantCovers("s-1", ["/tmp/other"])).toBe(false);
    // Boundary, not prefix.
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel-backup"])).toBe(false);
    // All of them or none: one new directory in the list is a new
    // question, whatever the others were.
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel", "/tmp/other"])).toBe(
      false,
    );
  });

  it("does not leak between sessions, or outlive the turn", () => {
    const scopes = new FanoutScopeRegistry();
    scopes.grantForTurn("s-1", ["/tmp/rel"]);
    expect(scopes.turnGrantCovers("s-2", ["/tmp/rel"])).toBe(false);
    scopes.clearTurnGrant("s-1");
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel"])).toBe(false);
  });

  it("keeps the turn answer apart from a worker's own scope", () => {
    // Different lifetimes, different maps: clearing the worker grant in
    // the fan-out's `finally` must not take the turn's answer with it,
    // or every fan-out would ask again and the fix would be invisible.
    const scopes = new FanoutScopeRegistry();
    scopes.grantForTurn("s-1", ["/tmp/rel"]);
    scopes.grant("s-w-1", ["/tmp/rel"]);
    scopes.clear("s-w-1");
    expect(scopes.allows("s-w-1", ["/tmp/rel/a.js"])).toBe(false);
    expect(scopes.turnGrantCovers("s-1", ["/tmp/rel"])).toBe(true);
  });
});
