import type { ServeRecord } from "./serve-reaper.js";

/**
 * ATO-2758 on top of ATO-2483: whether anything answers the shared model
 * right now, read from the records live servers leave in
 * `<stateDir>/serve/` (as `atag pair` does). `models share` only flips a
 * switch; the share listener that answers on the share port runs inside
 * a serve (or the desktop app's serve). Where it listens is the saved
 * mode: other-device addresses only for `--network`, like LM Studio,
 * which lists network addresses only while "Serve on Local Network" is on.
 */

export interface ShareReach {
  /** A live serve on record, so its share listener answers. */
  listening: boolean;
  mode: "local" | "network";
  port: number;
  urls: { local: string; lan: string[] };
}

export interface ShareReachInput {
  records: readonly ServeRecord[];
  isAlive: (pid: number) => boolean;
  mode: "local" | "network";
  port: number;
  /** `shareBaseUrls` of the port, LAN addresses only in network mode. */
  urls: { local: string; lan: string[] };
}

export function resolveShareReach(input: ShareReachInput): ShareReach {
  return {
    listening: input.records.some((r) => input.isAlive(r.pid)),
    mode: input.mode,
    port: input.port,
    urls: input.mode === "network" ? input.urls : { local: input.urls.local, lan: [] },
  };
}

/** Why serve's own `--api-key` is not the key above (ATO-2758). */
export const SHARE_KEY_NOTE =
  "The API key above reaches only the bare model. serve's own --api-key is another key: it guards the agent itself (its tools, files and settings), and the other app does not need it.";

export function formatShareSummary(input: {
  key: string;
  urls: { local: string; lan: string[] };
  rotated: boolean;
  network?: boolean;
  /** `false`: no serve runs, so nothing answers yet; absent reads as listening. */
  listening?: boolean;
}): string {
  const rotated = input.rotated ? " with a new key (apps using the old one now get 401)" : "";
  const lines: string[] = [];
  if (input.listening === false) {
    lines.push(
      `Model sharing is switched on${rotated}, but nothing answers yet: atomic-agent serve (or the desktop app) is not running.`,
      "Start it with: atomic-agent serve",
      "",
      "Then paste these into the other app (OpenAI-compatible):",
    );
  } else {
    lines.push(`Model sharing is on${rotated}.`, "Paste these into the other app (OpenAI-compatible):");
  }
  lines.push(`  Base URL, this computer:   ${input.urls.local}`);
  for (const url of input.urls.lan) lines.push(`  Base URL, other devices:   ${url}`);
  lines.push(
    `  API key:                   ${input.key}`,
    "",
    input.network
      ? "Other devices: a running serve (or the desktop app) opens this port on the network for the model routes only."
      : "Only this computer can reach it. For other devices too: atomic-agent models share --network",
    "Warning: traffic on the local network is plain http; anyone on the same network can read it.",
    SHARE_KEY_NOTE,
    "One request at a time: a second one gets 429 while the first runs. Stop with: atomic-agent models share --off",
  );
  return `${lines.join("\n")}\n`;
}
