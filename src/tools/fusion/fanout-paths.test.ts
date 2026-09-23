import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { collapseScope, resolveFanoutScope } from "./fanout-paths.js";
import type { DelegateTask } from "./delegate-args.js";

function task(patch: Partial<DelegateTask> = {}): DelegateTask {
  return {
    id: "t1",
    title: "Write a module",
    instructions: "Do the thing.",
    ...patch,
  };
}

const CWD = "/repo";

describe("resolveFanoutScope", () => {
  it("takes the directories a brief names in `files`", () => {
    const scope = resolveFanoutScope(
      [task({ files: ["/tmp/rel-2/cart.js", "/tmp/rel-2/cart.test.js"] })],
      CWD,
    );
    expect(scope).toContain("/tmp/rel-2");
  });

  it("reads paths out of the prose when `files` is empty", () => {
    // The session that exposed all of this: the orchestrator wrote every
    // path into the instructions and left `files` unset. Refusing to
    // read that would mean no scope and no fix.
    const scope = resolveFanoutScope(
      [
        task({
          instructions:
            "Create directory /tmp/rel-2 if needed. Write two files:\n" +
            "1. /tmp/rel-2/cart.js — export function addItem(cart, item).\n" +
            "2. /tmp/rel-2/cart.test.js — use node:test.",
        }),
      ],
      CWD,
    );
    expect(scope).toContain("/tmp/rel-2");
  });

  it("does not mistake prose for paths", () => {
    // A loose pattern over a model's writing finds version numbers and
    // sentence fragments, and every false positive widens what the
    // operator is about to authorise.
    const scope = resolveFanoutScope(
      [
        task({
          instructions:
            "Use node:test. Target v1.2.3 of the spec. Cover e.g. the empty case.",
        }),
      ],
      CWD,
    );
    expect(scope).toEqual([CWD]);
  });

  it("always includes the working directory as the floor", () => {
    expect(resolveFanoutScope([task()], CWD)).toEqual([CWD]);
  });

  it("resolves a relative path against the working directory", () => {
    const scope = resolveFanoutScope([task({ files: ["./src/a.ts"] })], CWD);
    expect(scope).toEqual(["/repo"]);
  });
});

describe("collapseScope", () => {
  it("keeps the shallowest directory that covers the others", () => {
    expect(collapseScope(["/tmp/x/sub", "/tmp/x", "/tmp/x/sub/deeper"])).toEqual(
      ["/tmp/x"],
    );
  });

  it("keeps genuinely separate roots apart", () => {
    expect(collapseScope(["/tmp/a", "/tmp/b"]).sort()).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("does not treat a sibling with a shared prefix as contained", () => {
    // `/tmp/rel-2-backup` is not inside `/tmp/rel-2`, however the
    // strings compare.
    expect(collapseScope(["/tmp/rel-2", "/tmp/rel-2-backup"]).sort()).toEqual([
      "/tmp/rel-2",
      "/tmp/rel-2-backup",
    ]);
  });

  it("refuses roots too broad to hand to a fan-out", () => {
    // One prompt authorises several workers to write unattended. `/` and
    // the home directory are not scopes, they are the absence of one.
    expect(collapseScope(["/"])).toEqual([]);
    expect(collapseScope([homedir()])).toEqual([]);
  });
});
