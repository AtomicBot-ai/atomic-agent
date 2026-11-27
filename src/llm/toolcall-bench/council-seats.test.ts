import { describe, expect, it } from "vitest";

import { COUNCIL_MAX_SEATS, SELF_MOA_TEMPERATURES, parseCouncilSeats, seatSpecs } from "./council-seats.js";

describe("parseCouncilSeats (ATO-2432)", () => {
  it("keeps one seat per named model, with no temperature", () => {
    expect(parseCouncilSeats("or:a, ollama:qwen3:8b", "or")).toEqual({
      ok: true,
      seats: [
        { id: "or:a", spec: "or:a" },
        { id: "ollama:qwen3:8b", spec: "ollama:qwen3:8b" },
      ],
    });
  });

  it("seats model*N N times under numbered ids at spread temperatures (Self-MoA)", () => {
    const result = parseCouncilSeats("or:a*3,or:b", "or");
    expect(result).toEqual({
      ok: true,
      seats: [
        { id: "or:a #1", spec: "or:a" },
        { id: "or:a #2", spec: "or:a", temperature: SELF_MOA_TEMPERATURES[1] },
        { id: "or:a #3", spec: "or:a", temperature: SELF_MOA_TEMPERATURES[2] },
        { id: "or:b", spec: "or:b" },
      ],
    });
    if (result.ok) expect(seatSpecs(result.seats)).toEqual(["or:a", "or:b"]);
  });

  it("counts a model named twice as a repeat too, so the ids stay unique", () => {
    const result = parseCouncilSeats("or:a,or:a", "or");
    expect(result.ok && result.seats.map((s) => s.id)).toEqual(["or:a #1", "or:a #2"]);
  });

  it("seats the fallback three times when nothing is named", () => {
    const result = parseCouncilSeats(undefined, "local");
    expect(result.ok && result.seats.map((s) => s.id)).toEqual(["local #1", "local #2", "local #3"]);
  });

  it("refuses more than the seat limit and a bad count", () => {
    expect(parseCouncilSeats(`a*${COUNCIL_MAX_SEATS + 1}`, "x")).toEqual({
      ok: false,
      reason: `a council has at most ${COUNCIL_MAX_SEATS} seats`,
    });
    expect(parseCouncilSeats("a*0", "x").ok).toBe(false);
    expect(parseCouncilSeats("*2", "x").ok).toBe(false);
  });
});
