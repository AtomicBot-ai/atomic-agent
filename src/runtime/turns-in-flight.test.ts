import { describe, expect, it } from "vitest";

import { TurnsInFlight } from "./turns-in-flight.js";

/**
 * What `shutdown` waits on before it closes the session store: the turns
 * their hosts stopped, so each can write its own end; never a turn
 * nobody stopped, and never longer than the grace.
 */

function stopped(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("TurnsInFlight.settleCancelled", () => {
  it("resolves at once when no turn has been stopped", async () => {
    const turns = new TurnsInFlight();
    // A scheduled task's turn (no signal) and a turn still being served.
    turns.begin(undefined);
    turns.begin(new AbortController().signal);
    const started = Date.now();
    expect(await turns.settleCancelled(5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(turns.size).toBe(2);
  });

  it("waits for a stopped turn to end", async () => {
    const turns = new TurnsInFlight();
    const turn = turns.begin(stopped());
    setTimeout(() => turn.end(), 30);
    expect(await turns.settleCancelled(5_000)).toBe(0);
    expect(turns.size).toBe(0);
  });

  it("gives up on a stopped turn that does not end within the grace", async () => {
    const turns = new TurnsInFlight();
    turns.begin(stopped());
    const ending = turns.begin(stopped());
    setTimeout(() => ending.end(), 10);
    const started = Date.now();
    expect(await turns.settleCancelled(80)).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("waits only for the stopped turns, not for one still running beside them", async () => {
    const turns = new TurnsInFlight();
    turns.begin(undefined);
    const stoppedTurn = turns.begin(stopped());
    setTimeout(() => stoppedTurn.end(), 10);
    const started = Date.now();
    expect(await turns.settleCancelled(5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(turns.size).toBe(1);
  });

  it("counts a turn once however often it is ended", () => {
    const turns = new TurnsInFlight();
    const turn = turns.begin(undefined);
    turns.begin(undefined);
    turn.end();
    turn.end();
    expect(turns.size).toBe(1);
  });
});
