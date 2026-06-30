import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_EXTRACT_LIMITS } from "../../tools/os/archive/archive-types.js";
import { ZipBackend } from "../../tools/os/archive/zip-backend.js";
import { parseSkillFile } from "../skill-manifest.js";
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
    const { manifest } = parseSkillFile(manifestFile.content);

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
