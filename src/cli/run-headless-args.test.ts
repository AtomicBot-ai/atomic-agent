import { describe, expect, it } from "vitest";

import { parseRunArgs, RUN_HELP } from "./run-agent.js";

/** ATO-2307: the headless flags of `atomic-agent run`. */
describe("run headless flags", () => {
  it("defaults to the text chat with nothing pinned or resumed", () => {
    expect(parseRunArgs([])).toMatchObject({
      outputFormat: "text",
      model: null,
      resume: null,
      outputLastMessage: null,
      prompt: null,
    });
  });

  it("reads every headless flag beside the old ones", () => {
    expect(
      parseRunArgs([
        "--output-format", "json",
        "--model", "openai:gpt-5",
        "--resume", "s-abc",
        "-o", "last.txt",
        "--max-steps", "4",
      ]),
    ).toMatchObject({
      outputFormat: "json",
      model: "openai:gpt-5",
      resume: "s-abc",
      outputLastMessage: "last.txt",
      maxSteps: 4,
    });
  });

  it("takes --json as stream-json and --continue as the latest chat", () => {
    expect(parseRunArgs(["--json", "-c"])).toMatchObject({
      outputFormat: "stream-json",
      resume: "latest",
    });
  });

  it("joins positional words into one prompt", () => {
    expect(parseRunArgs(["count", "files", "--json", "in src"])).toMatchObject({
      prompt: "count files in src",
      outputFormat: "stream-json",
    });
  });

  it("refuses a bad format, a missing value and an unknown flag", () => {
    expect(parseRunArgs(["--output-format", "yaml"])).toEqual({
      error: "--output-format must be text, json or stream-json",
    });
    expect(parseRunArgs(["--model"])).toEqual({
      error: "--model needs a model id or <provider>/<model>",
    });
    expect(parseRunArgs(["--resume", "--json"])).toEqual({ error: "--resume needs a chat id" });
    expect(parseRunArgs(["-o"])).toEqual({ error: "-o needs a file path" });
    expect(parseRunArgs(["--nope"])).toEqual({ error: "unknown flag: --nope" });
  });

  it("refuses resuming an incognito chat and an empty prompt", () => {
    expect(parseRunArgs(["--incognito", "--resume", "s-1"])).toEqual({
      error: "--incognito starts a new chat, so it cannot run with --resume or --continue",
    });
    expect(parseRunArgs(["  "])).toEqual({ error: "the prompt argument is empty" });
  });
});

/** ATO-2770: `--json` stays the JSONL stream; the help says so and names the one-object form. */
describe("run help on --json", () => {
  it("says --json is one event per line and points at --output-format json for one object", () => {
    const at = RUN_HELP.indexOf("  --json ");
    expect(at).toBeGreaterThan(-1);
    const entry = RUN_HELP.slice(at, RUN_HELP.indexOf("\n  -m,", at));
    expect(entry).toContain("one JSON event per line");
    expect(entry).toContain("--output-format json");
  });
});
