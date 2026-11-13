import { describe, expect, it } from "vitest";

import { idCommand } from "./id-command.js";

const ID = "11111111-2222-4333-8444-555555555555";

function run(args: string[], readId: () => string | null) {
  let out = "";
  let err = "";
  const code = idCommand(args, {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    readId,
  });
  return code.then((c) => ({ code: c, out, err }));
}

describe("atag id (ATO-1466)", () => {
  it("prints the support id alone on stdout", async () => {
    const r = await run([], () => ID);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${ID}\n`);
    expect(r.err).toBe("");
  });

  it("says so and exits 1 when there is no id yet", async () => {
    const r = await run([], () => null);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("no install id yet");
  });

  it("prints help without reading the id", async () => {
    let read = false;
    const r = await run(["--help"], () => {
      read = true;
      return ID;
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: atomic-agent id");
    expect(read).toBe(false);
  });

  it("rejects an unknown option", async () => {
    const r = await run(["--json"], () => ID);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown option --json");
  });
});
