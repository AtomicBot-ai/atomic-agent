import type { Recipe } from "./recipe-format.js";

/**
 * Built-in "Standup for the day" recipe (ATO-2363). It reads the local
 * logbook through `logbook.query` and writes a short Done / Next /
 * Blockers standup. Like every recipe it only fills the chat box: the
 * person reads it and sends it, and it chooses no model or tool
 * permission. `atomic-agent logbook standup` prints its text and its
 * `atomicagent://recipe/open` link.
 */
export const STANDUP_RECIPE: Recipe = {
  version: 1,
  title: "Standup for the day",
  description: "A short standup from your local logbook: what you did, what is next, what blocks you.",
  prompt: [
    "Write my standup for {{day}} from my logbook.",
    'Call logbook.query with day "{{day}}" to read what I worked on. It is a record of my screen kept on this computer and written by a local model.',
    "Group it into Done (3 to 6 bullets, by project or task, not by app), Next (what the last entries suggest I continue) and Blockers (only when the entries show one).",
    "Keep it under 120 words, in plain words, with times only where they matter.",
    "If the logbook has nothing for that day, say so and ask me what I did.",
  ].join("\n"),
  params: [{ key: "day", default: "yesterday", description: "today, yesterday or a date like 2026-11-26" }],
};
