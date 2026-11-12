import { describe, expect, it } from "vitest";

import { CRON_USAGE, parseCronCommand } from "./cron-command-parse.js";

describe("parseCronCommand", () => {
  it("lists on an empty argument and on list / ls", () => {
    expect(parseCronCommand("")).toEqual({ kind: "list" });
    expect(parseCronCommand("   ")).toEqual({ kind: "list" });
    expect(parseCronCommand(" list")).toEqual({ kind: "list" });
    expect(parseCronCommand("LS")).toEqual({ kind: "list" });
  });

  it("answers help", () => {
    expect(parseCronCommand("help")).toEqual({ kind: "help" });
  });

  it("takes the first five words of an unquoted add as the cron", () => {
    expect(parseCronCommand("add 0 9 * * 1-5 summarise my inbox")).toEqual({
      kind: "add",
      expression: "0 9 * * 1-5",
      message: "summarise my inbox",
    });
  });

  it("keeps the task text's own spacing and line breaks", () => {
    const parsed = parseCronCommand("add */15 * * * * check the build\nand tell me if it is red");
    expect(parsed).toEqual({
      kind: "add",
      expression: "*/15 * * * *",
      message: "check the build\nand tell me if it is red",
    });
  });

  it("reads a quoted cron, straight or curly, with any number of fields", () => {
    expect(parseCronCommand('add "0 0 9 * * *" digest')).toMatchObject({
      expression: "0 0 9 * * *",
      message: "digest",
    });
    expect(parseCronCommand("add “30 8 * * *” tea")).toMatchObject({
      expression: "30 8 * * *",
      message: "tea",
    });
    expect(parseCronCommand("add '0 9 * * *' x")).toMatchObject({ expression: "0 9 * * *" });
  });

  it("reads a single @macro as the cron", () => {
    expect(parseCronCommand("add @daily water the plants")).toEqual({
      kind: "add",
      expression: "@daily",
      message: "water the plants",
    });
  });

  it("reads --tz before the cron, with a space or =", () => {
    expect(parseCronCommand("add --tz Europe/Berlin 0 9 * * * digest")).toEqual({
      kind: "add",
      expression: "0 9 * * *",
      tz: "Europe/Berlin",
      message: "digest",
    });
    expect(parseCronCommand('add --tz=UTC "0 9 * * *" digest')).toMatchObject({
      tz: "UTC",
      expression: "0 9 * * *",
    });
  });

  it("accepts create / new as add", () => {
    expect(parseCronCommand("create @hourly ping")).toMatchObject({ kind: "add" });
    expect(parseCronCommand("new @hourly ping")).toMatchObject({ kind: "add" });
  });

  it("refuses an add without a task text", () => {
    const parsed = parseCronCommand("add 0 9 * * *");
    expect(parsed.kind).toBe("error");
    expect(parsed).toMatchObject({ message: expect.stringContaining("Say what the task should do") });
  });

  it("refuses an add with too few cron fields", () => {
    const parsed = parseCronCommand("add 0 9 *");
    expect(parsed).toMatchObject({
      kind: "error",
      message: expect.stringContaining("needs 5 fields"),
    });
  });

  it("refuses an unclosed quote and an empty add", () => {
    expect(parseCronCommand('add "0 9 * * * digest')).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no closing"),
    });
    expect(parseCronCommand("add")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Usage: /cron add"),
    });
  });

  it("reads pause / resume / delete and their aliases with an id", () => {
    expect(parseCronCommand("pause t-1a2b3c4d")).toEqual({ kind: "pause", id: "t-1a2b3c4d" });
    expect(parseCronCommand("resume 1a2b")).toEqual({ kind: "resume", id: "1a2b" });
    expect(parseCronCommand("delete t-1a2b")).toEqual({ kind: "delete", id: "t-1a2b" });
    expect(parseCronCommand("rm t-1a2b")).toEqual({ kind: "delete", id: "t-1a2b" });
    expect(parseCronCommand("remove t-1a2b")).toEqual({ kind: "delete", id: "t-1a2b" });
  });

  it("asks for the id when it is missing", () => {
    expect(parseCronCommand("pause")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Usage: /cron pause <id>"),
    });
  });

  it("names an unknown subcommand and shows the usage", () => {
    const parsed = parseCronCommand("frobnicate");
    expect(parsed).toMatchObject({ kind: "error" });
    expect((parsed as { message: string }).message).toContain("Unknown /cron subcommand: frobnicate");
    expect((parsed as { message: string }).message).toContain(CRON_USAGE);
  });
});
