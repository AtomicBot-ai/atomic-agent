import { afterEach, describe, expect, it } from "vitest";

import type { ToolSecretSource } from "../config/tool-secrets.js";
import { maskSecrets } from "../error-reporting/secret-detector.js";
import { resetResolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import {
  checkToolSecretNames,
  describeToolSecretUse,
  fillToolSecretTexts,
} from "./tool-secret-use.js";

const VALUE = "Shared8Secret9Value0";

/** `DEMO_TOKEN` only. It does NOT register its value: the helper must. */
function source(value = VALUE, resolved: string[] = []): ToolSecretSource {
  return {
    has: (name) => name === "DEMO_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return value;
    },
  };
}

afterEach(() => resetResolvedSecretValues());

describe("tool secret use (ATO-2530)", () => {
  it("checks names without fetching anything", () => {
    const resolved: string[] = [];
    expect(checkToolSecretNames(["Bearer {{secret:DEMO_TOKEN}}"], source(VALUE, resolved))).toEqual({
      ok: true,
      names: ["DEMO_TOKEN"],
    });
    expect(resolved).toEqual([]);
    expect(checkToolSecretNames(["{{secret:OTHER}}"], source())).toEqual({
      ok: false,
      message: expect.stringContaining("unknown secret OTHER"),
    });
    expect(checkToolSecretNames(["{{secret:}}"], source())).toMatchObject({ ok: false });
    expect(checkToolSecretNames(["{{secret:DEMO_TOKEN}}"], undefined)).toMatchObject({ ok: false });
    expect(checkToolSecretNames(["plain"], undefined)).toEqual({ ok: true, names: [] });
  });

  it("says which secrets a call uses and when they go in", () => {
    expect(describeToolSecretUse([])).toBe("");
    expect(describeToolSecretUse(["A_KEY"])).toContain("uses secret A_KEY: filled in when it starts");
    expect(describeToolSecretUse(["A_KEY", "B_KEY"], "when it is sent")).toContain(
      "uses secrets A_KEY, B_KEY: filled in when it is sent, masked in output (exact value)",
    );
  });

  it("fills the texts and registers the value for masking, whatever the source did", async () => {
    const filled = await fillToolSecretTexts(["x={{secret:DEMO_TOKEN}}", "plain"], ["DEMO_TOKEN"], source(), { shell: false });
    expect(filled).toEqual({ ok: true, texts: [`x=${VALUE}`, "plain"] });
    // The source above never called rememberResolvedSecret.
    expect(maskSecrets(`echo ${VALUE}`)).not.toContain(VALUE);
  });

  it("applies the shell rule per text and refuses a NUL in a value", async () => {
    const spaced = source("Has Space And12345");
    const perText = await fillToolSecretTexts(
      ["{{secret:DEMO_TOKEN}}", "{{secret:DEMO_TOKEN}}"],
      ["DEMO_TOKEN"],
      spaced,
      { shell: (index) => index === 0 },
    );
    expect(perText).toMatchObject({ ok: false });
    const envOnly = await fillToolSecretTexts(["{{secret:DEMO_TOKEN}}"], ["DEMO_TOKEN"], spaced, { shell: () => false });
    expect(envOnly).toEqual({ ok: true, texts: ["Has Space And12345"] });
    const nul = await fillToolSecretTexts(["{{secret:DEMO_TOKEN}}"], ["DEMO_TOKEN"], source("Nul\0Value12345678"), { shell: false });
    expect(nul).toMatchObject({ ok: false, message: expect.stringContaining("NUL") });
    expect(JSON.stringify(nul)).not.toContain("Value12345678");
  });
});
