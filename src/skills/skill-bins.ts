import type { SkillPlatform } from "./skill-manifest.js";

/**
 * ATO-526: the external programs a skill runs (`gh`, `docker`, `icalBuddy`…)
 * and the install line to show when one is missing. Read from the SKILL.md
 * frontmatter; nothing here looks at the disk or runs anything — the
 * desktop does the PATH lookup and only displays the hint.
 *
 *   requires_bins: [gh]
 *   install:
 *     darwin: brew install gh
 *     linux: apt-get install gh
 *
 * An entry may list alternatives, `magick|convert`: any one of them on PATH
 * is enough (ImageMagick 6 ships only `convert`).
 *
 * `install` may also be one string for every platform (stored as `any`).
 * ClawHub/OpenClaw skills declare the same thing under
 * `metadata.openclaw` (`requires.bins`, `install: [{kind: brew, formula}]`);
 * that is read when the top-level keys are absent, so installed hub skills
 * get the check without being rewritten.
 */

export type SkillInstallHints = Partial<Record<SkillPlatform | "any", string>>;

export interface SkillBinsFields {
  requiresBins?: string[];
  installHints?: SkillInstallHints;
}

/** A bare program name: no slash, no spaces, so it can only be looked up on PATH. */
const BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** A Homebrew formula / npm package name as given by the skill (shown, never run). */
const PACKAGE_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/+-]{0,127}$/;
const MAX_BINS = 16;
const MAX_HINT = 200;
const HINT_KEYS = ["darwin", "linux", "win32", "any"] as const;
const OPENCLAW_KEYS = ["openclaw", "clawdbot", "clawdis"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function binList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const parts = v.split("|").map(p => p.trim());
    const name = parts.join("|");
    if (parts.length <= 4 && parts.every(p => BIN_RE.test(p)) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_BINS) break;
  }
  return out;
}

function hint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line && line.length <= MAX_HINT ? line : undefined;
}

function hintMap(value: unknown): SkillInstallHints | undefined {
  const single = hint(value);
  if (single) return { any: single };
  const map = record(value);
  if (!map) return undefined;
  const out: SkillInstallHints = {};
  for (const key of HINT_KEYS) {
    const line = hint(map[key]);
    if (line) out[key] = line;
  }
  return Object.keys(out).length ? out : undefined;
}

/** OpenClaw `install: [{kind: "brew", formula}, {kind: "node", package}]` → display lines. */
function openclawHints(value: unknown): SkillInstallHints | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SkillInstallHints = {};
  for (const entry of value) {
    const e = record(entry);
    if (!e) continue;
    const formula = typeof e.formula === "string" ? e.formula.trim() : "";
    const pkg = typeof e.package === "string" ? e.package.trim() : "";
    if (e.kind === "brew" && PACKAGE_RE.test(formula) && !out.darwin) out.darwin = `brew install ${formula}`;
    if (e.kind === "node" && PACKAGE_RE.test(pkg) && !out.any) out.any = `npm install -g ${pkg}`;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The two optional manifest fields, each set only when the frontmatter declares it. */
export function parseSkillBins(frontmatter: Record<string, unknown>): SkillBinsFields {
  let bins = binList(frontmatter.requires_bins);
  let hints = hintMap(frontmatter.install);
  const metadata = record(frontmatter.metadata);
  for (const key of OPENCLAW_KEYS) {
    const block = record(metadata?.[key]);
    if (!block) continue;
    if (!bins.length) bins = binList(record(block.requires)?.bins);
    if (!hints) hints = openclawHints(block.install);
    break;
  }
  return {
    ...(bins.length ? { requiresBins: bins } : {}),
    ...(bins.length && hints ? { installHints: hints } : {}),
  };
}
