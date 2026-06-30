import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_EXTRACT_LIMITS } from "../../tools/os/archive/archive-types.js";
import { ZipBackend } from "../../tools/os/archive/zip-backend.js";
import {
  isValidSkillName,
  parseSkillFile,
  SkillManifestError,
} from "../skill-manifest.js";
import {
  scanSkillFiles,
  type ScannableFile,
  type SkillScanFinding,
  type SkillScanResult,
} from "../hub/skill-security-scanner.js";
import {
  SkillHubInstallError,
  type StagedSkillInstall,
} from "../hub/install-from-hub.js";
import {
  ClawHubClient,
  type ClawHubScanStatus,
} from "./clawhub-client.js";
import { parseClawHubIdentifier } from "./clawhub-source.js";

/**
 * ClawHub install pipeline: download the skill version ZIP from the
 * registry, extract it (through the shared zip-slip / bomb-guarded
 * {@link ZipBackend}) into a temp dir, run BOTH the registry's ClawScan
 * verdict and the local heuristic scanner, then hand the temp dir to the
 * same {@link commitStagedInstall} / {@link discardStagedInstall} path
 * used for GitHub-tap installs. The on-disk install is identical to a
 * local install — `SKILL.md` sits at the root of the extracted bundle.
 */

export interface StageClawHubOptions {
  identifier: string;
  client?: ClawHubClient;
  /** Override temp root (tests). Defaults to the OS temp dir. */
  tmpRoot?: string;
}

export async function stageSkillFromClawHub(
  options: StageClawHubOptions,
): Promise<StagedSkillInstall> {
  let ref: { owner: string | null; slug: string };
  try {
    ref = parseClawHubIdentifier(options.identifier);
  } catch (err) {
    throw new SkillHubInstallError(
      err instanceof Error ? err.message : String(err),
      "invalid_identifier",
    );
  }

  const client = options.client ?? new ClawHubClient();
  const zip = await client.downloadZip({
    slug: ref.slug,
    owner: ref.owner,
    tag: "latest",
  });

  const tmpBase = options.tmpRoot ?? tmpdir();
  const sourceDir = await mkdtemp(join(tmpBase, "atomic-clawhub-"));
  try {
    const report = await new ZipBackend().extract(zip, {
      destDir: sourceDir,
      overwrite: true,
      followSymlinks: false,
      limits: DEFAULT_EXTRACT_LIMITS,
    });
    if (report.extractedEntries === 0) {
      throw new SkillHubInstallError(
        `skill archive for ${options.identifier} was empty or fully rejected`,
        "manifest_missing",
      );
    }

    const files = await collectScannableFiles(sourceDir);
    const manifestFile = files.find((f) => f.path === "SKILL.md");
    if (!manifestFile) {
      throw new SkillHubInstallError(
        `SKILL.md not found in ${options.identifier}`,
        "manifest_missing",
      );
    }

    let manifest;
    try {
      ({ manifest } = parseSkillFile(manifestFile.content));
    } catch (err) {
      if (!(err instanceof SkillManifestError)) throw err;
      // ClawHub manifests often carry a human-readable display `name`
      // ("Powerpoint / PPTX") that fails the kebab-case manifest rule.
      // Coerce it to a kebab name derived from the registry slug so the
      // skill installs — and later loads — cleanly. The on-disk SKILL.md
      // is rewritten so the commit re-parse and the loader both agree.
      const kebab = isValidSkillName(ref.slug)
        ? ref.slug
        : deriveKebabName(ref.slug);
      const rewritten = kebab
        ? rewriteManifestName(manifestFile.content, kebab)
        : null;
      if (!rewritten) throw err;
      ({ manifest } = parseSkillFile(rewritten));
      await writeFile(join(sourceDir, "SKILL.md"), rewritten, "utf8");
      manifestFile.content = rewritten;
    }

    const heuristic = scanSkillFiles(files);
    const registry = await client.getScanStatus({
      slug: ref.slug,
      owner: ref.owner,
      tag: "latest",
    });
    const scan = mergeRegistryVerdict(heuristic, registry);

    return {
      identifier: options.identifier,
      manifest,
      scan,
      sourceDir,
    };
  } catch (err) {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Fold the registry's ClawScan verdict into the heuristic scan result so
 * the existing confirm / block logic (which keys off `scan.verdict`)
 * accounts for both signals. A `malicious` registry verdict escalates to
 * `dangerous`; `suspicious` escalates to at least `caution`.
 */
export function mergeRegistryVerdict(
  heuristic: SkillScanResult,
  registry: ClawHubScanStatus,
): SkillScanResult {
  if (registry === "clean" || registry === "unknown") return heuristic;
  const finding: SkillScanFinding =
    registry === "malicious"
      ? {
          severity: "dangerous",
          rule: "clawhub-malicious",
          file: "SKILL.md",
          line: 0,
          excerpt: "ClawHub security scan flagged this version as malicious",
        }
      : {
          severity: "caution",
          rule: "clawhub-suspicious",
          file: "SKILL.md",
          line: 0,
          excerpt: "ClawHub security scan flagged this version as suspicious",
        };
  const verdict =
    registry === "malicious"
      ? "dangerous"
      : heuristic.verdict === "dangerous"
        ? "dangerous"
        : "caution";
  return {
    verdict,
    findings: [finding, ...heuristic.findings],
  };
}

/**
 * Slugify an arbitrary string into a kebab-case skill name (a-z, 0-9,
 * '-'), clamped to 64 chars and trimmed of leading/trailing dashes.
 * Returns null when nothing usable (>= 2 chars) survives.
 */
export function deriveKebabName(raw: string): string | null {
  const slug = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : null;
}

/**
 * Rewrite the first `name:` line in a SKILL.md YAML frontmatter block
 * with `kebab`. Returns null when the frontmatter is missing/unclosed or
 * carries no `name:` line, so the caller can fall back to the original
 * validation error.
 */
export function rewriteManifestName(
  content: string,
  kebab: string,
): string | null {
  const normalised = content.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return null;
  const closingIndex = normalised.indexOf("\n---", 4);
  if (closingIndex === -1) return null;
  const frontmatter = normalised.slice(4, closingIndex);
  const rest = normalised.slice(closingIndex);
  let replaced = false;
  const lines = frontmatter.split("\n").map((line) => {
    if (!replaced && /^name\s*:/.test(line)) {
      replaced = true;
      return `name: ${kebab}`;
    }
    return line;
  });
  if (!replaced) return null;
  return `---\n${lines.join("\n")}${rest}`;
}

async function collectScannableFiles(root: string): Promise<ScannableFile[]> {
  const out: ScannableFile[] = [];
  const MAX_SCAN_BYTES = 512 * 1024;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let content: string;
      try {
        const buf = await readFile(abs);
        if (buf.byteLength > MAX_SCAN_BYTES) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }
      out.push({ path: relative(root, abs).split("\\").join("/"), content });
    }
  }
  await walk(root);
  return out;
}
