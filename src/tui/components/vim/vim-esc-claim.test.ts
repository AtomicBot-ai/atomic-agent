import { describe, expect, it } from "vitest";
import { createVimEscClaim, noteVimKey, vimClaimsEsc } from "./vim-esc-claim.js";
import { createVimState } from "./vim-types.js";

describe("vim Esc claim (ATO-662)", () => {
  it("claims nothing while the editor is not live", () => {
    const claim = { ...createVimEscClaim(), insert: true };
    expect(vimClaimsEsc(claim)).toBe(false);
    expect(vimClaimsEsc(undefined)).toBe(false);
  });

  it("claims Esc in INSERT and with a pending command, before vim sees it", () => {
    const claim = { ...createVimEscClaim(), active: true, insert: true };
    expect(vimClaimsEsc(claim)).toBe(true);
    claim.insert = false;
    claim.pending = true;
    expect(vimClaimsEsc(claim)).toBe(true);
    claim.pending = false;
    expect(vimClaimsEsc(claim)).toBe(false);
  });

  it("keeps the claim for the Esc vim just spent, then lets it go", async () => {
    const claim = { ...createVimEscClaim(), active: true };
    noteVimKey(claim, createVimState("insert"), createVimState("normal"), true);
    // vim already moved to NORMAL; the Esc in flight is still its own.
    expect(vimClaimsEsc(claim)).toBe(true);
    await Promise.resolve();
    expect(vimClaimsEsc(claim)).toBe(false);
  });

  it("does not claim a bare Esc in NORMAL", () => {
    const claim = { ...createVimEscClaim(), active: true };
    noteVimKey(claim, createVimState("normal"), createVimState("normal"), true);
    expect(vimClaimsEsc(claim)).toBe(false);
  });
});
