import { describe, it, expect } from "vitest";
import { ProbeRuns, probeFamily } from "./wandering-spread.js";

/** Record a completed probe that returned content. */
function probe(runs: ProbeRuns, tool: string, hash: string): void {
  runs.record(tool, hash, true);
}

describe("ProbeRuns", () => {
  it("counts distinct signatures, folding in the prospective call", () => {
    const runs = new ProbeRuns();
    expect(runs.spread("os.web.search", "q1")).toBe(1);
    probe(runs, "os.web.search", "q1");
    probe(runs, "os.web.search", "q2");
    expect(runs.spread("os.web.search", "q3")).toBe(3);
    // An already-counted signature does not add to the spread.
    expect(runs.spread("os.web.search", "q2")).toBe(2);
  });

  it("settles a run when another tool succeeds", () => {
    const runs = new ProbeRuns();
    probe(runs, "os.web.search", "q1");
    probe(runs, "os.web.search", "q2");
    expect(runs.spread("os.web.search", "q3")).toBe(3);
    runs.record("os.shell.run", "sh1", true);
    expect(runs.spread("os.web.search", "q3")).toBe(1);
  });

  it("does not settle a run on a FAILED call by another tool", () => {
    const runs = new ProbeRuns();
    probe(runs, "os.web.search", "q1");
    probe(runs, "os.web.search", "q2");
    runs.record("os.shell.run", "sh1", false);
    expect(runs.spread("os.web.search", "q3")).toBe(3);
  });

  it("does not settle a run on the probe tool's own success", () => {
    const runs = new ProbeRuns();
    for (const q of ["q1", "q2", "q3"]) probe(runs, "os.web.search", q);
    expect(runs.spread("os.web.search", "q4")).toBe(4);
  });

  it("settles search when a fetch opens one of its results, and keeps fetch's own run", () => {
    const runs = new ProbeRuns();
    for (const q of ["q1", "q2", "q3"]) probe(runs, "os.web.search", q);
    // A gate reads between steps; nothing outside the search family has
    // landed yet, so the run stands.
    expect(runs.spread("os.web.search", "q4")).toBe(4);
    probe(runs, "os.web.fetch", "u1");
    expect(runs.spread("os.web.search", "q4")).toBe(1);
    // ...and the fetch that settled it opened its own run, which its own
    // family cannot settle.
    probe(runs, "os.web.fetch", "u2");
    expect(runs.spread("os.web.fetch", "u3")).toBe(3);
  });

  it("keeps each tool's run independent", () => {
    const runs = new ProbeRuns();
    probe(runs, "browser.click", "c1");
    probe(runs, "browser.click", "c2");
    expect(runs.spread("browser.navigate", "n1")).toBe(1);
    expect(runs.spread("browser.click", "c3")).toBe(3);
  });

  it("does NOT settle a run from inside its own family", () => {
    // Clicking around is read-click-read-click: two tools, one probe.
    // Letting them settle each other would leave the pair unbounded --
    // and "clicking around" is what the browser redirect is written for.
    const runs = new ProbeRuns();
    for (let i = 0; i < 12; i += 1) {
      probe(runs, "browser.read_aria", `r${i}`);
      probe(runs, "browser.click", `c${i}`);
    }
    expect(runs.spread("browser.click", "c12")).toBe(13);
    expect(runs.spread("browser.read_aria", "r12")).toBe(13);
    // `os.http.request` is `os.web.fetch` by another name, so neither
    // settles the other either.
    const web = new ProbeRuns();
    for (let i = 0; i < 4; i += 1) {
      probe(web, "os.web.fetch", `f${i}`);
      probe(web, "os.http.request", `h${i}`);
    }
    expect(web.spread("os.web.fetch", "f4")).toBe(5);
  });

  it("does not depend on the order a parallel batch resolves in", () => {
    // `os.fs.grep` and `os.web.fetch` are both pure reads, so the batch
    // fans out and the local grep beats the network home. The run
    // boundary must not be decided by that race.
    const grepFirst = new ProbeRuns();
    grepFirst.record("os.fs.grep", "g", true);
    for (let i = 0; i < 7; i += 1) probe(grepFirst, "os.web.fetch", `u${i}`);
    const grepLast = new ProbeRuns();
    for (let i = 0; i < 7; i += 1) probe(grepLast, "os.web.fetch", `u${i}`);
    grepLast.record("os.fs.grep", "g", true);
    expect(grepFirst.spread("os.web.fetch", "u7")).toBe(
      grepLast.spread("os.web.fetch", "u7"),
    );
    expect(grepLast.spread("os.web.fetch", "u7")).toBe(1);
  });
});

describe("probeFamily", () => {
  it("groups the tools that are two moves of one probe", () => {
    expect(probeFamily("os.web.search")).toBe("search");
    expect(probeFamily("os.web.fetch")).toBe("fetch");
    expect(probeFamily("os.http.request")).toBe("fetch");
    expect(probeFamily("browser.click")).toBe("browser");
    expect(probeFamily("browser.read_aria")).toBe("browser");
    expect(probeFamily("os.fs.read")).toBeNull();
    expect(probeFamily("memory.notes.recall")).toBeNull();
  });

  it("counts a failed probe: a dead URL is still an attempt", () => {
    const runs = new ProbeRuns();
    runs.record("os.web.fetch", "u1", false);
    runs.record("os.web.fetch", "u2", false);
    expect(runs.spread("os.web.fetch", "u3")).toBe(3);
  });

  it("never counts a non-probe tool toward a run", () => {
    const runs = new ProbeRuns();
    runs.record("os.fs.read", "a", true);
    runs.record("os.fs.read", "b", true);
    expect(runs.spread("os.fs.read", "c")).toBe(1);
  });
});
