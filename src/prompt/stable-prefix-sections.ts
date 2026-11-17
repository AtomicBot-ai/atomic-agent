import { createHash } from "node:crypto";

/**
 * Per-section view of a built stable prefix (ATO-316).
 *
 * `buildStablePrefix` renders one string made of `### <name>` blocks
 * (`### system`, `### rules`, `### skills`, `### tools`, ...). The trace
 * hashes the whole string, which says *that* the KV-cached prefix moved
 * but not *where*. Splitting on the same headers the prompt already
 * carries names the block that changed without the builder having to
 * report anything: whatever it renders, this reads.
 *
 * Text before the first header (Gemma turn framing, a reasoning token)
 * is its own `head` section so a change there is not blamed on persona.
 */

/** Name of the text that precedes the first `### ` header. */
export const PREFIX_HEAD_SECTION = "head";

/**
 * A header line: `### ` and a lowercase slug, nothing else. Tool
 * summaries and skill lines never start a line this way; a persona
 * override that does just shows up as one more section.
 */
const SECTION_HEADER = /^### ([a-z][a-z0-9-]*)$/;

export interface StablePrefixSection {
  name: string;
  text: string;
}

/** Split a stable prefix into its `### ` sections, in prompt order. */
export function splitStablePrefixSections(prefix: string): StablePrefixSection[] {
  const sections: StablePrefixSection[] = [];
  let name = PREFIX_HEAD_SECTION;
  let lines: string[] = [];
  const flush = (): void => {
    // An empty head (the common case) is not a section.
    if (name === PREFIX_HEAD_SECTION && lines.join("").trim() === "") return;
    sections.push({ name, text: lines.join("\n") });
  };
  for (const line of prefix.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      flush();
      name = header[1]!;
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * Section name → short content hash. A name that repeats (it should
 * not) gets a `#2` suffix so neither copy hides the other.
 */
export type StablePrefixSectionHashes = Readonly<Record<string, string>>;

export function hashStablePrefixSections(prefix: string): StablePrefixSectionHashes {
  const hashes: Record<string, string> = {};
  for (const section of splitStablePrefixSections(prefix)) {
    let key = section.name;
    for (let n = 2; key in hashes; n += 1) key = `${section.name}#${n}`;
    hashes[key] = createHash("sha256").update(section.text).digest("hex").slice(0, 16);
  }
  return hashes;
}

/**
 * Sections whose hash differs between two steps, in `next` order, then
 * any that `next` dropped. Added and removed sections count as changed:
 * both move every byte after them.
 */
export function diffStablePrefixSections(
  prev: StablePrefixSectionHashes,
  next: StablePrefixSectionHashes,
): string[] {
  const changed: string[] = [];
  for (const [name, hash] of Object.entries(next)) {
    if (prev[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(prev)) {
    if (!(name in next)) changed.push(name);
  }
  return changed;
}

/** Words a person reads for a section name; unknown names pass through. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  [PREFIX_HEAD_SECTION]: "turn framing",
  system: "persona",
  rules: "rules",
  "answer-style": "answer style",
  skills: "skills",
  tools: "tool catalog",
  capabilities: "capabilities",
  integrations: "integrations",
  fusion: "fusion",
  instructions: "instructions",
};

export function describePrefixSection(name: string): string {
  const base = name.replace(/#\d+$/, "");
  return SECTION_LABELS[base] ?? base;
}
