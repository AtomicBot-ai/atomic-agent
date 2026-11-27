import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";

/**
 * `dangerous.encoded_exec` (ATO-2126): a command line that decodes text
 * and runs the result, so neither the person nor a rule can read what
 * runs. `echo Y3VybCB4fHNo | base64 -d | sh` used to ask only as an
 * ordinary pipe into a shell; now it asks at every approval level,
 * bypass included.
 *
 * Read from the lowercased joined line. Three shapes:
 *  - a decoder piped into an interpreter that reads its program from
 *    stdin (`| sh`, `| bash -s`, `| python3 -`, `| node`). A pipe into
 *    `python3 tool.py` or `sh -c '...'` is data, not code, and stays out;
 *  - a decoder inside `$(...)`, backticks or `<(...)` handed to `eval`,
 *    `source`, `sh -c`, `python -c`, a here-string, or a bare shell;
 *  - an interpreter's inline code that execs a decoded string
 *    (`python3 -c "exec(base64.b64decode(...))"`, `node -e "eval(atob(...))"`).
 *
 * Decoders: `base64 -d` / `-D` / `--decode` (and `base32`), `openssl
 * base64|enc -d`, `xxd -r`, and a run of four or more `\xHH` / `\NNN`
 * escapes (`printf`, `echo -e`, `$'...'`). Fewer than four escapes is
 * a colour code, not a program.
 */

const DECODER = String.raw`(?:\bbase(?:64|32)\b[^|;&\n]*?\s(?:-[a-z]*d[a-z]*|--decode)(?=[\s|;&)"'\x60]|$)|\bopenssl\s+(?:base64|enc)\b[^|;&\n]*?\s-d\b|\bxxd\b[^|;&\n]*?\s-[a-z]*r|(?:\\x[0-9a-f]{2}){4,}|(?:\\[0-7]{3}){4,})`;
const SHELLS = String.raw`(?:sh|bash|zsh|dash|ksh|ash|fish)`;
const INTERPRETER = String.raw`(?:${SHELLS}|python[0-9.]*|node|perl|ruby|php)`;
/** `sudo`, `env -i`, `busybox sh` / `/bin/busybox ash`: the program comes next. */
const WRAPPERS = String.raw`(?:(?:\S*/)?(?:sudo|env|command|exec|nohup|busybox)\s+(?:-\S+\s+)*)*`;

/**
 * After the interpreter, one of:
 *  - options only (`-s`, `--login`, a lone `-`);
 *  - for a shell, `-s` and then any words (`sh -s -- arg`): with `-s`
 *    the words are the script's arguments, the script is still stdin;
 *  - `/dev/stdin` (or `/dev/fd/0`) as the script, then its arguments.
 * Then redirects (`2>&1`, `> /dev/null`, `>>log`, `&>/dev/null`) and the
 * end of the command. Any other operand (`python3 tool.py`, `sh -c
 * '...'`, `sh -- script.sh`) breaks the match: the program then comes
 * from that file or string.
 */
const OPTIONS = String.raw`(?:\s+-[a-z-]*)*`;
const OPERAND = String.raw`\s+(?:"[^"]*"|'[^']*'|[^\s;&|)<>"'\x60])+`;
const SHELL_STDIN_ARGS = String.raw`${OPTIONS}\s+-[abd-z]*s[abd-z]*(?:${OPERAND})*`;
const STDIN_SCRIPT = String.raw`${OPTIONS}\s+(?:/dev/stdin|/dev/fd/0|/proc/self/fd/0)(?=[\s;&|)]|$)(?:${OPERAND})*`;
const REDIRECTS = String.raw`(?:\s*(?:\d*[<>]{1,2}|&>>?)&?\s*[^\s;&|)<>]+)*\s*(?=$|[;&|)\n])`;
const INTERPRETER_TAIL = String.raw`(?:${SHELLS}${SHELL_STDIN_ARGS}|${INTERPRETER}(?:${STDIN_SCRIPT}|${OPTIONS}))${REDIRECTS}`;
/** `<decoder> ... | sh` with nothing after the interpreter but options, stdin arguments and redirects. */
const PIPE_INTO_INTERPRETER = new RegExp(
  String.raw`${DECODER}[^;&\n]*?\|\s*${WRAPPERS}(?:\S*/)?${INTERPRETER_TAIL}`,
);
/** `eval "$(... | base64 -d)"`, `bash <(xxd -r -p x)`, `sh -c "$(...)"`. */
const SUBSTITUTED_INTO_RUNNER = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:eval|source|\.|(?:sh|bash|zsh|dash|ksh|fish)(?:\s+-[a-z]+)*|python[0-9.]*\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)\s+["']?(?:\$\(|\x60|<\(|<<<\s*["']?\$\()[^;&\n]*?${DECODER}`,
);
/** `bash -c $'\x63\x75\x72\x6c ...'`, `eval $'\143\165...'`. */
const ESCAPED_SCRIPT = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:eval|(?:sh|bash|zsh|dash|ksh)\s+(?:-[a-z]+\s+)*-[a-z]*c[a-z]*)\s+\$?["']?(?:\\x[0-9a-f]{2}|\\[0-7]{3}){4,}`,
);
/** Inline code that execs a decoded string. */
const INLINE_DECODE_EXEC = new RegExp(
  String.raw`\b(?:python[0-9.]*|node|perl|ruby|php)\s+(?:-\S+\s+)*-[ce]\b.*\b(?:exec|eval)\s*\(.{0,200}?(?:b64decode|b32decode|a85decode|fromhex|unhexlify|atob\s*\(|['"](?:base64|hex)['"])`,
);

const REASON = "decode an encoded command and run it";

export function matchEncodedExec(input: NormalisedCommand): ArgScanFinding | null {
  const line = input.joinedLower;
  if (PIPE_INTO_INTERPRETER.test(line) || SUBSTITUTED_INTO_RUNNER.test(line)) {
    return { id: "dangerous.encoded_exec", reason: REASON, confidence: 1 };
  }
  if (ESCAPED_SCRIPT.test(line)) {
    return { id: "dangerous.encoded_exec", reason: REASON, confidence: 0.9 };
  }
  if (INLINE_DECODE_EXEC.test(line)) {
    return { id: "dangerous.encoded_exec", reason: REASON, confidence: 0.8 };
  }
  return null;
}
