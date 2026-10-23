import { describe, expect, it } from "vitest";
import { JSON_FIX } from "../../grammar/repair-tool-call-json.js";
import { openAiToolCallsToBatch, withStrictNullArgumentDrop, openAiToolCallAdapter } from "./openai-tool-call-adapter.js";

describe("openAiToolCallsToBatch with repairJson", () => {
  const call = (args: string) => [
    { id: "c1", type: "function" as const, function: { name: "os__fs__read", arguments: args } },
  ];

  it("repairs a broken argument string only when asked", () => {
    expect(() => openAiToolCallsToBatch(call('{"path":"a.ts",}'))).toThrow();
    const batch = openAiToolCallsToBatch(call('{"path":"a.ts",}'), undefined, { repairJson: true });
    expect(batch.calls[0]?.args).toEqual({ path: "a.ts" });
    expect(batch.jsonRepair?.fixes).toEqual([JSON_FIX.trailingComma]);
  });

  it("still throws when nothing repairs it", () => {
    expect(() =>
      openAiToolCallsToBatch(call("{ not json"), undefined, { repairJson: true }),
    ).toThrow();
  });

  it("passes the repair flag through the strict null-drop wrapper", () => {
    const wrapped = withStrictNullArgumentDrop(openAiToolCallAdapter);
    const batch = wrapped.toolCallsToBatch(call('{"path":"a.ts","maxBytes":null,}'), undefined, { repairJson: true });
    expect(batch.calls[0]?.args).toEqual({ path: "a.ts" });
    expect(batch.jsonRepair?.fixes).toEqual([JSON_FIX.trailingComma]);
  });
});
