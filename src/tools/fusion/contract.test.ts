import { describe, expect, it } from "vitest";

import {
  contractWarnings,
  MAX_CONTRACT_RENDERED_CHARS,
  ownedPaths,
  provideSearchPaths,
  renderContractBlock,
  renderContractForTask,
  uncheckableProvides,
  unprovidedRequires,
  type DelegateContract,
} from "./contract.js";

const CONTRACT: DelegateContract = {
  owners: { "js/ship.js": "ship", "index.html": "html", "js/main.js": "main" },
  provides: [
    { task: "ship", kind: "symbol", name: "HD.Ship", in: "js/ship.js" },
    { task: "html", kind: "id", name: "btn-launch", in: "index.html" },
    { task: "ship", kind: "file", name: "js/hud.js" },
  ],
  requires: [
    { task: "main", name: "HD.Ship" },
    { task: "main", name: "btn-launch" },
  ],
  checks: [
    { task: "main", kind: "page", path: "index.html", checks: ["no errors"] },
    { kind: "command", cmd: "node", args: ["--check", "js/main.js"] },
  ],
};

describe("renderContractBlock", () => {
  it("renders every section, each entry tagged with its task", () => {
    const block = renderContractBlock(CONTRACT);
    expect(block.split("\n")[0]).toMatch(/^CONTRACT — the interface between the parts/);
    expect(block).toContain("OWNERS (path → task; write only in paths you own):");
    expect(block).toContain("- js/ship.js → ship");
    expect(block).toContain("PROVIDES:");
    expect(block).toContain("- [ship] symbol HD.Ship in js/ship.js");
    expect(block).toContain("- [html] id btn-launch in index.html");
    expect(block).toContain("- [ship] file js/hud.js");
    expect(block).toContain("REQUIRES:");
    // Grouped per task, so a worker reads one line for its dependencies.
    expect(block).toContain("- [main] HD.Ship, btn-launch");
    expect(block).toContain("CHECKS (run after the fan-out; a failing check fails its task):");
    expect(block).toContain(
      '- [main] {"kind":"page","path":"index.html","checks":["no errors"]}',
    );
    // A call-level check has no tag; its `task` key is not part of the spec.
    expect(block).toContain('- {"kind":"command","cmd":"node","args":["--check","js/main.js"]}');
    expect(block).not.toContain('"task"');
  });

  it("omits sections the contract does not declare", () => {
    const block = renderContractBlock({
      provides: [{ task: "a", kind: "file", name: "x.txt" }],
    });
    expect(block).toContain("PROVIDES:");
    expect(block).not.toContain("OWNERS");
    expect(block).not.toContain("REQUIRES");
    expect(block).not.toContain("CHECKS");
  });

  it("clips one check's JSON so a huge spec cannot eat the block", () => {
    const block = renderContractBlock({
      checks: [{ kind: "command", cmd: "x".repeat(2000) }],
    });
    expect(block.length).toBeLessThan(MAX_CONTRACT_RENDERED_CHARS);
    expect(block).toContain("…");
  });
});

describe("renderContractForTask", () => {
  it("says what this task owns, provides and may rely on, resolving each require to its source", () => {
    const main = renderContractForTask(CONTRACT, "main");
    expect(main.split("\n")).toEqual([
      "You own: js/main.js",
      "You provide: nothing listed",
      "You may rely on: HD.Ship (symbol from ship in js/ship.js); btn-launch (id from html in index.html)",
    ]);
    const ship = renderContractForTask(CONTRACT, "ship");
    expect(ship).toContain("You own: js/ship.js");
    expect(ship).toContain("You provide: symbol HD.Ship in js/ship.js; file js/hud.js");
    expect(ship).toContain("You may rely on: nothing from the other parts");
  });

  it("tells a task that owns nothing to stay inside its TASK's files", () => {
    const lines = renderContractForTask(CONTRACT, "nobody");
    expect(lines).toContain(
      "You own: no path in this contract — write only the files your TASK names",
    );
  });

  it("lists owned paths in declaration order", () => {
    expect(
      ownedPaths({ owners: { b: "t", a: "t", c: "u" } }, "t"),
    ).toEqual(["b", "a"]);
  });
});

describe("contract warnings", () => {
  // What a live Gemma 4 31B orchestrator wrote: a require nothing
  // provides, and a provide with nowhere to be looked for. Each was a
  // refusal costing minutes; both are notes now.
  const LOOSE: DelegateContract = {
    provides: [
      { task: "html", kind: "id", name: "btn-launch", in: "index.html" },
      { task: "organize", kind: "other", name: "done" },
    ],
    requires: [
      { task: "main", name: "btn-launch" },
      { task: "index", name: "organized_files" },
    ],
  };
  const TASKS = [{ id: "html" }, { id: "organize" }, { id: "main" }, { id: "index" }];
  const PROVIDE_NOTE =
    'provides "done" (task organize) cannot be checked: no `in`, no owned path, no declared files';
  const REQUIRE_NOTE =
    'requires "organized_files" (task index) has no provider — nothing produces it';

  it("names the uncheckable provide and the unprovided require, in that order", () => {
    expect(uncheckableProvides(LOOSE, TASKS)).toEqual([LOOSE.provides![1]]);
    expect(unprovidedRequires(LOOSE)).toEqual([LOOSE.requires![1]]);
    expect(contractWarnings(LOOSE, TASKS)).toEqual([PROVIDE_NOTE, REQUIRE_NOTE]);
    expect(contractWarnings(CONTRACT, [])).toEqual([]);
  });

  it("looks for a provide in `in`, else the owned paths, else the declared files — never a glob", () => {
    const provide = { task: "t", kind: "symbol" as const, name: "X" };
    expect(provideSearchPaths({ ...provide, in: "a.js" }, { owners: { "b.js": "t" } }, { id: "t", files: ["c.js"] })).toEqual(["a.js"]);
    expect(provideSearchPaths(provide, { owners: { "b.js": "t", "js/**": "t" } }, { id: "t", files: ["c.js"] })).toEqual(["b.js"]);
    expect(provideSearchPaths(provide, {}, { id: "t", files: ["c.js", "d/*.js"] })).toEqual(["c.js"]);
    expect(provideSearchPaths(provide, { owners: { "js/**": "t" } }, { id: "t", files: ["d/*.js"] })).toEqual([]);
    expect(provideSearchPaths(provide, {}, undefined)).toEqual([]);
    // A file provide is its own path and is never uncheckable.
    expect(uncheckableProvides({ provides: [{ task: "t", kind: "file", name: "x.txt" }] }, [])).toEqual([]);
  });

  it("the block keeps the uncheckable provide as declared, drops the unprovided require from REQUIRES and appends both notes", () => {
    const block = renderContractBlock({ ...LOOSE, warnings: contractWarnings(LOOSE, TASKS) });
    expect(block).toContain("- [organize] other done");
    expect(block).toContain("REQUIRES:\n- [main] btn-launch\n");
    expect(block).not.toContain("- [index] organized_files");
    expect(block.split("\n").slice(-2)).toEqual([
      `contract: ${PROVIDE_NOTE}`,
      `contract: ${REQUIRE_NOTE}`,
    ]);
    // Without stored warnings the block says nothing — the parser is the one that stores them.
    expect(renderContractBlock(LOOSE)).not.toContain("contract: ");
  });

  it("a task's own line drops a require nobody provides", () => {
    expect(renderContractForTask(LOOSE, "index")).toContain(
      "You may rely on: nothing from the other parts",
    );
    expect(renderContractForTask(LOOSE, "main")).toContain(
      "You may rely on: btn-launch (id from html in index.html)",
    );
  });
});
