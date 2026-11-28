import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";

/**
 * `dangerous.encoded_exec` through a file (ATO-2505): decode into a file,
 * then run that file later on the same line. `echo Y3Vy.. | base64 -d >
 * x.sh && sh x.sh`, `certutil -decode p.b64 p.exe & p.exe`, `xxd -r -p
 * h.txt run && chmod +x run && ./run`. The pipe and substitution shapes
 * of `rules-encoded-exec.ts` never see these: nothing is piped into the
 * interpreter.
 *
 * A decoder writes a file through `> F` / `>> F`, `-o F` / `--output F`
 * (base64), `-out F` (openssl), a second operand (`xxd -r in F`,
 * `certutil -decode in F`) or PowerShell `WriteAllBytes('F', [Convert]::
 * FromBase64String(..))`. The file runs when, after the decoder, it is
 * handed to a shell or interpreter (`sh F`, `python3 F`, `source F`,
 * `powershell -File F`, `& F`, `start F`, `cmd /c F`), made executable
 * (`chmod +x F`), or is itself the program of a command (`./F`, `F.exe`).
 * Merely naming it (`ls F`, `cat F`) is not running it.
 */

const REDIRECT_OUT = String.raw`\s*>>?\s*(["']?)([^\s;&|<>"']+)\1`;
const WRITES_FILE: readonly RegExp[] = [
  new RegExp(String.raw`\bbase(?:64|32)\b[^|;&\n]*?\s(?:-[a-z]*d[a-z]*|--decode)\b[^|;&\n]*?(?:${REDIRECT_OUT}|\s(?:-o|--output)[=\s]\s*(["']?)([^\s;&|<>"']+)\3)`, "g"),
  new RegExp(String.raw`\bopenssl\s+(?:base64|enc)\b[^|;&\n]*?\s-d\b[^|;&\n]*?(?:${REDIRECT_OUT}|\s-out\s+(["']?)([^\s;&|<>"']+)\3)`, "g"),
  new RegExp(String.raw`\bxxd\b[^|;&\n]*?\s-[a-z]*r[a-z]*\b(?:\s+-\S+)*(?:${REDIRECT_OUT}|\s+[^\s;&|<>-]\S*\s+(["']?)([^\s;&|<>"'-][^\s;&|<>"']*)\3)`, "g"),
  new RegExp(String.raw`\bcertutil(?:\.exe)?\s+(?:-f\s+)?-decode(?:hex)?\s+\S+\s+(["']?)([^\s;&|<>"']+)\1`, "g"),
  new RegExp(String.raw`\bwriteallbytes\s*\(\s*(["'])([^"']+)\1\s*,[^;\n]*?frombase64string`, "g"),
  // printf / echo -e of four or more escapes, written out.
  new RegExp(String.raw`\b(?:printf|echo\s+-e)\s+["']?(?:\\x[0-9a-f]{2}|\\[0-7]{3}){4,}[^|;&\n]*?${REDIRECT_OUT}`, "g"),
];

const RUNNERS = String.raw`(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|py|node|deno|bun|perl|ruby|php|osascript|source|\.|start|cmd(?:\.exe)?\s+/c|(?:powershell|pwsh)(?:\.exe)?(?:\s+(?!-f(?:ile)?\b)\S+)*?\s+-f(?:ile)?|&|chmod\s+(?:-\S+\s+)*(?:[ugoa]*\+[rwx]*x[rwx]*|[0-7]*[1357][0-7]{0,2}))`;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The file is run, or made runnable, somewhere in `rest`. */
function runsFile(rest: string, file: string): boolean {
  const name = file.replace(/^\.\//, "");
  const spelled = String.raw`["']?(?:\./|\.\\)?${escapeRegex(name)}["']?(?=$|[\s;&|)])`;
  const handed = new RegExp(String.raw`(?:^|[\s;&|(])${RUNNERS}\s+${spelled}`);
  const asProgram = new RegExp(String.raw`(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+|exec\s+)?${spelled}`);
  return handed.test(rest) || asProgram.test(rest);
}

export function matchEncodedExecFile(input: NormalisedCommand): ArgScanFinding | null {
  const line = input.joinedLower;
  for (const pattern of WRITES_FILE) {
    for (const match of line.matchAll(pattern)) {
      const groups = match.slice(1);
      const file = [groups[1], groups[3]].find((value) => value !== undefined && value.length > 0);
      if (file === undefined) continue;
      const rest = line.slice(match.index + match[0]!.length);
      if (!runsFile(rest, file)) continue;
      return {
        id: "dangerous.encoded_exec",
        reason: `decode an encoded file and run it (${file})`,
        confidence: 1,
      };
    }
  }
  return null;
}
