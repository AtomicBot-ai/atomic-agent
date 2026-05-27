import type { GuardInput, NormalisedCommand } from "./guard-types.js";

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const NULL_BYTES = /\x00/g;
const CONTROL_CHARS = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function basenameCommand(cmd: string): string {
  const normalised = cmd.replace(/\\/g, "/");
  const idx = normalised.lastIndexOf("/");
  return idx === -1 ? normalised : normalised.slice(idx + 1);
}

export function normaliseCommand(input: GuardInput): NormalisedCommand {
  const cmdOriginal = normaliseField(basenameCommand(input.cmd));
  const args = input.rawArgs.map(normaliseField);
  const joined = normaliseWhitespace(`${cmdOriginal} ${args.join(" ")}`.trim());
  return {
    cmd: cmdOriginal.toLowerCase(),
    cmdOriginal,
    args,
    joined,
    joinedLower: joined.toLowerCase(),
  };
}

function normaliseField(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ANSI_ESCAPE, "")
    .replace(NULL_BYTES, "")
    .replace(CONTROL_CHARS, " ");
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
