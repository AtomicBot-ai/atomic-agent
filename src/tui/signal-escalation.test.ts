import { describe, expect, it } from "vitest";
import { makeEscalatingSignalHandler } from "./signal-escalation.js";

interface Recorded {
  quits: number;
  restores: number;
  exits: number[];
}

function makeHandler(): { handler: () => void; seen: Recorded } {
  const seen: Recorded = { quits: 0, restores: 0, exits: [] };
  const handler = makeEscalatingSignalHandler({
    quit: () => (seen.quits += 1),
    restoreTerminal: () => (seen.restores += 1),
    exit: (code) => seen.exits.push(code),
  });
  return { handler, seen };
}

describe("makeEscalatingSignalHandler", () => {
  it("asks for a graceful quit on the first signal only", () => {
    const { handler, seen } = makeHandler();
    handler();
    expect(seen).toEqual({ quits: 1, restores: 0, exits: [] });
  });

  it("restores the terminal before dying on a repeat signal", () => {
    // A wedged shutdown killed again must not fall through to Node's
    // default handler — that skips `exit` hooks and leaves the shell in
    // mouse-reporting mode, printing coordinates on every click.
    const { handler, seen } = makeHandler();
    handler();
    handler();
    expect(seen.quits).toBe(1);
    expect(seen.restores).toBe(1);
    expect(seen.exits).toEqual([130]);
  });

  it("keeps escalating for every further signal", () => {
    const { handler, seen } = makeHandler();
    handler();
    handler();
    handler();
    expect(seen.quits).toBe(1);
    expect(seen.restores).toBe(2);
    expect(seen.exits).toEqual([130, 130]);
  });
});
