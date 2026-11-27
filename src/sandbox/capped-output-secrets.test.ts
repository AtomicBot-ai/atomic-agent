import { afterEach, describe, expect, it } from "vitest";

import { CappedOutput, hideSecretPiecesAtCut } from "./capped-output.js";
import { rememberResolvedSecret, resetResolvedSecretValues } from "./resolved-secret-values.js";

const SECRET = "Cut4Across7The9Middle";

afterEach(() => resetResolvedSecretValues());

describe("CappedOutput: a tool secret split by the dropped middle (ATO-476)", () => {
  it("hides the piece left on each side of the cut", () => {
    rememberResolvedSecret("DEPLOY_TOKEN", SECRET);
    // Cap 40: 10 bytes of head, 30 of tail. The secret starts at byte 4,
    // so its first 6 characters end the head; then the middle is dropped
    // and the tail window starts inside a later copy of it.
    const out = new CappedOutput(40);
    out.append(Buffer.from(`ab: ${SECRET}`));
    out.append(Buffer.from("x".repeat(200)));
    out.append(Buffer.from(`${SECRET.slice(9)} end of output, twelve`));
    const { text, truncated } = out.snapshot();
    expect(truncated).toBe(true);
    expect(text).not.toContain(SECRET.slice(0, 6));
    expect(text).toContain("ab: [redacted:DEPLOY_TOKEN]");
  });

  it("hides a leading end of a secret at the start of the tail", () => {
    const [head, tail] = hideSecretPiecesAtCut("start ", `${SECRET.slice(5)} rest`, [
      { label: "X_TOKEN", value: SECRET },
    ]);
    expect(head).toBe("start ");
    expect(tail).toBe("[redacted:X_TOKEN] rest");
  });

  it("leaves output alone when nothing was dropped or no secret is known", () => {
    const out = new CappedOutput(1024);
    out.append(Buffer.from(`ab: ${SECRET.slice(0, 6)}`));
    expect(out.snapshot().text).toBe(`ab: ${SECRET.slice(0, 6)}`);
    expect(hideSecretPiecesAtCut("abc Cut4", "x", [])).toEqual(["abc Cut4", "x"]);
  });
});
