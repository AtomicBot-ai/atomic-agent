/**
 * Heuristic pre-install scanner for hub skills. Pure function over the
 * already-downloaded files — no I/O. Mirrors the spirit of Hermes' skill
 * security scan: flag data exfiltration, destructive commands, remote
 * code execution, credential harvesting, and prompt-injection markers.
 *
 * This is a best-effort tripwire, NOT a sandbox. A `dangerous` verdict
 * blocks install unless the operator explicitly acknowledges the risk;
 * `caution` surfaces a confirmation prompt.
 */

export type SkillScanVerdict = "ok" | "caution" | "dangerous";

export type SkillScanSeverity = "caution" | "dangerous";

export interface SkillScanFinding {
  severity: SkillScanSeverity;
  /** Short rule label, e.g. "remote-exec". */
  rule: string;
  /** File the match was found in (relative path). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed and length-capped. */
  excerpt: string;
}

export interface SkillScanResult {
  verdict: SkillScanVerdict;
  findings: SkillScanFinding[];
}

export interface ScannableFile {
  /** Relative path within the skill dir. */
  path: string;
  content: string;
}

interface ScanRule {
  rule: string;
  severity: SkillScanSeverity;
  pattern: RegExp;
}

/**
 * Ordered rule set. `dangerous` rules are unambiguous destructive /
 * exfiltration patterns; `caution` rules flag capabilities that merit a
 * human glance (network access, secret references, injection phrasing).
 */
const RULES: readonly ScanRule[] = [
  // --- dangerous ---
  { rule: "remote-exec", severity: "dangerous", pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i },
  { rule: "decode-exec", severity: "dangerous", pattern: /base64\s+(--decode|-d|-D)\b[^\n|]*\|\s*(ba)?sh\b/i },
  { rule: "recursive-delete", severity: "dangerous", pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)/i },
  { rule: "fork-bomb", severity: "dangerous", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { rule: "disk-wipe", severity: "dangerous", pattern: /\b(mkfs|dd\s+if=)[^\n]*\bof=\/dev\/|>\s*\/dev\/sd[a-z]/i },
  { rule: "chmod-root", severity: "dangerous", pattern: /\bchmod\s+-R?\s*777\s+\//i },
  { rule: "history-wipe", severity: "dangerous", pattern: /\b(history\s+-c|>\s*~\/\.bash_history)\b/i },
  // --- caution ---
  { rule: "credential-read", severity: "caution", pattern: /(~\/\.ssh\b|~\/\.aws\b|\.aws\/credentials|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|PRIVATE_KEY|id_rsa)/ },
  { rule: "netcat", severity: "caution", pattern: /\bnc\s+(-[a-z]+\s+)*[\w.-]+\s+\d+/i },
  { rule: "network-fetch", severity: "caution", pattern: /\b(curl|wget|Invoke-WebRequest)\b/i },
  { rule: "eval", severity: "caution", pattern: /\b(eval|exec)\s*\(/ },
  { rule: "prompt-injection", severity: "caution", pattern: /\b(ignore (all )?(previous|prior) instructions|disregard (the )?(system )?prompt|you are now)\b/i },
];

const EXCERPT_MAX = 160;

/** File extensions worth scanning beyond SKILL.md (scripts). */
const SCRIPT_EXTENSIONS = [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".ts", ".ps1", ".rb"];

function isScannable(path: string): boolean {
  if (path === "SKILL.md" || path.endsWith("/SKILL.md")) return true;
  const lower = path.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function scanSkillFiles(files: readonly ScannableFile[]): SkillScanResult {
  const findings: SkillScanFinding[] = [];
  for (const file of files) {
    if (!isScannable(file.path)) continue;
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({
            severity: rule.severity,
            rule: rule.rule,
            file: file.path,
            line: i + 1,
            excerpt: truncate(line.trim(), EXCERPT_MAX),
          });
        }
      }
    }
  }
  return { verdict: verdictOf(findings), findings };
}

function verdictOf(findings: readonly SkillScanFinding[]): SkillScanVerdict {
  if (findings.some((f) => f.severity === "dangerous")) return "dangerous";
  if (findings.length > 0) return "caution";
  return "ok";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Compact one-line summary for logs / TUI headers. */
export function summarizeScan(result: SkillScanResult): string {
  if (result.verdict === "ok") return "scan: ok (no findings)";
  const byRule = new Map<string, number>();
  for (const f of result.findings) {
    byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  }
  const parts = Array.from(byRule.entries()).map(([rule, n]) => `${rule}×${n}`);
  return `scan: ${result.verdict} (${parts.join(", ")})`;
}
