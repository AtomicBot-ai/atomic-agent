import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "../expand-home.js";
import { BROWSER_BUNDLE_IDS } from "../screen/screen-protected.js";
import type { GuardVerdict } from "./guard-types.js";
import { basenameCommand } from "./normalise.js";
import { lexShellLine, type ShellWord } from "./shell-line-lexer.js";

/**
 * `os.shell.run` does not drive web browsers (ATO-1260). With the
 * browser tool failing, a model reached for `osascript` (`set URL of
 * active tab …`, `get {URL, title} of active tab`) and `open -a "Google
 * Chrome" <url>`, which took it to a site and onto a sign-in form with
 * none of the browser tool's own checks: no ask before a submit, a
 * payment or a password (#864), no blocked domains, no masking of secret
 * fields. The same split screen control makes (#884, `screen-protected.ts`):
 * a browser is something the browser tool acts in, nothing else.
 *
 * Refused, at every approval level:
 *
 * - AppleScript / JXA (`osascript`, `osascript -l JavaScript`, a
 *   heredoc or here-string, and bridges to it from other languages —
 *   appscript, ScriptingBridge, `NSAppleScript`, `run-applescript`) that
 *   names a browser, opens a URL (`open location`, `openURL`) or a web
 *   file, runs JavaScript in a page, or synthesises input through System
 *   Events (`keystroke`, `key code`, `click`), which lands in whichever
 *   app is in front. A script that hides what it talks to (a target built
 *   at runtime, `run script`, a script file, piped-in text) is refused
 *   too, since it cannot be read here. `tell application "<browser>" to
 *   quit` / `to activate` (and `quit app`, JXA `.quit()` / `.activate()`)
 *   stay allowed.
 * - `open` handing a web URL, a `.webloc` / `.html`-like file, or a
 *   runtime-built operand to the default browser, `open -u`, and `open
 *   -a <browser>` / `-b <browser id>` with anything to open (an operand,
 *   `--args`, input from `xargs`). A bare `open -a "Google Chrome"`
 *   (start or bring forward) runs. The Linux / Windows openers
 *   (`xdg-open`, `gio open`, `wslview`, `start`, `explorer`,
 *   `rundll32 url.dll`, `sensible-browser`) the same way.
 * - A browser binary run with arguments (`google-chrome <url>`,
 *   `…/Google Chrome.app/Contents/MacOS/Google Chrome --headless …`),
 *   `--version` / `--help` aside.
 * - The DevTools protocol (a `DevToolsActivePort` file, `/json/new` on a
 *   loopback port, `/devtools/browser/…`, `connectOverCDP`,
 *   `--remote-debugging-port`), Python's `webbrowser`, `shortcuts run`
 *   and `automator` (script runners whose steps are not visible here),
 *   `defaults write` into a browser's settings, the input synthesisers
 *   (`cliclick`, `xdotool type`, `ydotool`, `wtype`), and a command
 *   decoded at run time (`base64 -d | sh`), which would carry any of
 *   these past the check.
 *
 * Wrappers are looked through: `sh -c` / `bash -lc` lines, `env`,
 * `sudo`, `nohup`, `xargs`, `eval`, `time`, `timeout`. Quitting a
 * browser (`killall "Google Chrome"`, `pkill`), installing one (`brew
 * install --cask`), and opening a folder, a document or any other app
 * are untouched. Matching is on the command's text, so a browser named
 * in a quoted string of an unrelated command (an `echo`) passes; only
 * scripting contexts look for one.
 */

export const BROWSER_BYPASS_RULE = "browser.use_browser_tool";

const REFUSAL =
  "os.shell.run does not control web browsers: use the browser tool instead (browser.navigate / browser.tabs to open a page, browser.read_aria to read it, browser.click / browser.type to act). It asks before submits, payments and passwords, and the shell would skip that. If the browser tool cannot reach Chrome, tell the user what its error says rather than working around it. Quitting or starting the app is fine: osascript -e 'tell application \"Google Chrome\" to quit', open -a \"Google Chrome\"";

function refuse(what: string): GuardVerdict {
  return { action: "block", rule: BROWSER_BYPASS_RULE, reason: `${what}. ${REFUSAL}` };
}

/** App names of web browsers, lowercased, without `.app`. */
const BROWSER_APP_NAME =
  /^(?:safari(?: technology preview)?|(?:google )?chrome(?: beta| dev| canary)?|chromium|arc|dia|(?:microsoft )?edge(?: beta| dev| canary)?|firefox(?: developer edition| nightly)?|firefox|brave(?: browser)?(?: beta| nightly)?|opera(?: gx| air)?|vivaldi|orion|duckduckgo|zen(?: browser)?|tor browser|yandex(?: browser)?|(?:naver )?whale|waterfox|mullvad browser|librewolf|floorp|sigmaos|helium|comet|(?:chatgpt )?atlas)$/;

/** Executable names of browsers (Linux, Windows, and the binary inside a macOS bundle). */
const BROWSER_BINARY =
  /^(?:google-chrome(?:-stable|-beta|-unstable)?|chromium(?:-browser)?|chrome|msedge|microsoft-edge(?:-stable|-beta|-dev)?|brave(?:-browser)?(?:-stable|-beta|-nightly)?|firefox(?:-esr|-developer-edition)?|opera|vivaldi(?:-stable)?|librewolf|waterfox|floorp|zen|safari|epiphany|falkon|midori|qutebrowser)(?:\.exe)?$/;

/** A browser mentioned anywhere in a script: distinctive names as words, short ones only quoted. */
const BROWSER_MENTION = new RegExp(
  [
    "\\b(?:safari|chrome|chromium|firefox|vivaldi|duckduckgo|librewolf|waterfox|floorp|sigmaos|yandex|thebrowser|torbrowser|tor browser|microsoft edge|msedge|brave|opera|operagx|webkit)\\b",
    "[\"'](?:arc|edge|orion|zen|zen browser|dia|helium|comet|atlas|chatgpt atlas|whale|mullvad browser)(?:\\.app)?[\"']",
    ...BROWSER_BUNDLE_IDS.map((id) => id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ].join("|"),
);

/** The line is (or bridges to) AppleScript / JXA. */
const SCRIPTING_CONTEXT =
  /\bosascript\b|\bosacompile\b|applescript|appscript|scriptingbridge|sbapplication|osakit|\bjxa\b|nsworkspace/;

/** Statements that only quit or bring forward an app; removed before the browser scan. */
const SEP = `(?:\\s|["']?\\s*-e\\s*["']?|;|¬)+`;
const QUIT_OR_ACTIVATE: readonly RegExp[] = [
  new RegExp(`tell\\s+(?:application|app)\\s+(?:id\\s+)?"[^"$\`]*"\\s+to\\s+(?:quit|activate)(?:\\s+saving\\s+no)?`, "g"),
  new RegExp(`tell\\s+(?:application|app)\\s+(?:id\\s+)?"[^"$\`]*"${SEP}(?:quit|activate)(?:\\s+saving\\s+no)?${SEP}end\\s+tell`, "g"),
  /\b(?:quit|activate)\s+(?:application|app)\s+(?:id\s+)?"[^"$`]*"(?:\s+saving\s+no)?/g,
  /application\(\s*["'][^"'$`]*["']\s*\)\.(?:quit|activate)\(\s*\)/g,
];

interface ScriptProblem {
  test: RegExp;
  what: string;
}

/** What a script may not do once quit/activate statements are taken out. */
const SCRIPT_PROBLEMS: readonly ScriptProblem[] = [
  { test: BROWSER_MENTION, what: "AppleScript/JavaScript for Automation that talks to a web browser" },
  {
    test: /system events[\s\S]*\b(?:keystroke|key\s+code|key\s+down|click)\b|\b(?:keystroke|key\s*code)\s*\(/,
    what: "synthesised keystrokes or clicks through System Events (they land in whatever app is in front, a browser included)",
  },
  {
    test: /\bopen\s+location\b|openlocation|openurl|open_url|https?:\/\/|file:\/\/|\.(?:html?|xhtml|webloc|inetloc|url|mhtml?|webarchive)\b/,
    what: "a script that opens a web address or a web file",
  },
  { test: /\b(?:do|execute)\b[^\n]{0,40}\bjavascript\b/, what: "a script that runs JavaScript in a web page" },
  {
    test: /tell\s+(?:application|app)\s+(?!(?:id\s+)?["'])|tell\s+(?:application|app)\s+(?:id\s+)?["'][^"']*[$`]|(?:application|app)\s+(?:id\s+)?"[^"]*"\s*&|application\(\s*(?!["'])|application\(\s*["'][^"']*["']\s*\+/,
    what: "a script whose target app is built at run time, so it cannot be checked",
  },
  {
    test: /\b(?:run|load)\s+script\b|\bosacompile\b|objc\s*\.\s*(?:import|bindfunction)|\beval\s*\(/,
    what: "a script that runs other script text, so it cannot be checked",
  },
  {
    test: /-e\s+["']?\$|\$\(|`/,
    what: "a script built at run time, so it cannot be checked",
  },
];

/** Text-level refusals that hold wherever they appear in the line. */
const LINE_PROBLEMS: readonly ScriptProblem[] = [
  {
    test: /devtoolsactiveport|remote-debugging-(?:port|pipe|address)|(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+\/json\b|\/devtools\/(?:browser|page)\/|connectovercdp|connect_over_cdp|browserwsendpoint|chrome-remote-interface|chrome-devtools-mcp/,
    what: "the browser's DevTools connection",
  },
  {
    test: /\bimport\s+webbrowser\b|\bfrom\s+webbrowser\b|-m\s+webbrowser\b|\bwebbrowser\s*\.\s*open|require\(\s*["']open["']\s*\)|from\s+["']open["']/,
    what: "a script that opens the default browser",
  },
  { test: /\bshortcuts\s+run\b|\bautomator\s/, what: "Shortcuts/Automator workflows (their steps are not visible here)" },
  {
    test: /\bdefaults\s+(?:-currenthost\s+)?(?:write|delete|import|rename)\s+(?:~\/library\/preferences\/)?(?:com\.apple\.safari|com\.google\.chrome|org\.chromium|com\.brave|com\.microsoft\.edge|org\.mozilla|company\.thebrowser|com\.operasoftware|com\.vivaldi|com\.kagi|com\.duckduckgo)/,
    what: "changing a web browser's settings",
  },
  {
    test: /(?:\bbase64\s+(?:-[a-z]*d|--decode)|\bb64decode\b|\batob\s*\(|\bxxd\s+-r|\bopenssl\s+(?:enc\s+)?-?base64\s+-d)[\s\S]*(?:\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|osascript|python\d*(?:\.\d+)?|perl|ruby|node|xargs|open|eval)\b|\beval\b|\bexec\s*\(|\bos\.system\b|\bsubprocess\b)|\beval\b[\s\S]*(?:\bbase64\s+(?:-[a-z]*d|--decode)|\bxxd\s+-r)/,
    what: "a command decoded at run time, so it cannot be checked",
  },
  {
    test: /(?:^|[\s;&|(`'"])(?:\S*\/)?(?:open|xdg-open|wslview)\s+(?:-[a-z]+\s+)*["']?(?:https?|ftp|file|javascript|data|view-source):/,
    what: "opening a web address in the browser",
  },
  {
    // `system("open", "-a", "Safari", "https://…")`, `subprocess.run(["open", url])` with the URL spelled out.
    test: /["'](?:open|xdg-open)["']\s*,\s*(?:["']-[a-z]["']\s*,\s*(?:["'][^"']*["']\s*,\s*)?)*["'](?:https?|ftp|file|javascript|data):/,
    what: "opening a web address in the browser",
  },
];

/** Commands that run the command after them; the value-taking flags of each. */
const PREFIX_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p", "-c", "-r", "-t", "-C", "-D", "-U"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-P", "--unset", "--chdir"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  nice: ["-n", "--adjustment"],
  time: ["-f", "-o", "--format", "--output"],
  caffeinate: ["-t", "-w"],
  arch: [],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  gtimeout: ["-s", "-k", "--signal", "--kill-after"],
  stdbuf: ["-i", "-o", "-e"],
  unbuffer: [],
  noglob: [],
  xargs: ["-I", "-i", "-n", "-L", "-l", "-P", "-d", "-E", "-e", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"],
  watch: ["-n", "-d", "--interval"],
};

const NESTED_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

const WEB_SCHEME = /^(?:https?|ftp|file|javascript|data|about|view-source|chrome|edge|brave|opera|vivaldi|safari-\S*|x-safari-https?|googlechromes?|firefox|microsoft-edge|webcal):/i;
const WEB_FILE = /\.(?:html?|xhtml|shtml|webloc|inetloc|url|mhtml?|webarchive|svg|xml)$/i;
/** A bare `www.example.com` or `example.com/path`, which `open` also hands to the browser. */
const BARE_HOST = /^(?:www\.)[^\s/]+|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i;

function isBrowserAppName(value: string): boolean {
  const name = basenameCommand(value.replace(/\/+$/, ""))
    .toLowerCase()
    .replace(/\.app$/, "")
    .trim();
  return BROWSER_APP_NAME.test(name);
}

function isBrowserBundleId(value: string): boolean {
  const id = value.toLowerCase();
  return BROWSER_BUNDLE_IDS.some((known) => {
    const k = known.toLowerCase();
    return id === k || id.startsWith(`${k}.`);
  });
}

function isWebTarget(word: ShellWord): boolean {
  const text = word.text.trim();
  return WEB_SCHEME.test(text) || WEB_FILE.test(text) || BARE_HOST.test(text);
}

interface CommandContext {
  /** The operands come (also) from stdin through `xargs`. */
  viaXargs: boolean;
  depth: number;
  /** Where a script file named by the command is read from. */
  cwd: string;
}

/**
 * The refusal for a command line run through the subshell (`sh -c`),
 * or `null`. A line the lexer cannot read is still checked as text.
 */
export function checkBrowserBypassLine(line: string, cwd: string): GuardVerdict | null {
  return checkText(line, line) ?? checkLineCommands(line, { viaXargs: false, depth: 0, cwd });
}

/** The refusal for a direct exec (`spawn(cmd, args)`), or `null`. */
export function checkBrowserBypassArgv(
  cmd: string,
  args: readonly string[],
  cwd: string,
): GuardVerdict | null {
  const words = [cmd, ...args].map((text) => ({ text, dynamic: false }));
  const text = [cmd, ...args].join(" ");
  return checkText(text, text) ?? checkCommand(words, { viaXargs: false, depth: 0, cwd });
}

/** Interpreters whose first operand is a script file read here before it runs. */
const SCRIPT_RUNNERS =
  /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python\d*(?:\.\d+)?|node|deno|bun|tsx|ts-node|ruby|perl|php|swift|lua|osascript|jxa)$/;
const SCRIPT_READ_CAP = 1_000_000;

/**
 * The text of a script file a command runs (`bash x.sh`, `python3 x.py`,
 * `./x.sh`), `null` when there is none to read; `"binary"` for a file
 * that is not text (a compiled `.scpt`).
 */
function readScriptFile(word: ShellWord, cwd: string): string | "binary" | null {
  if (word.dynamic) return null;
  try {
    const path = resolve(cwd, expandHome(word.text));
    const info = statSync(path);
    if (!info.isFile() || info.size > SCRIPT_READ_CAP) return null;
    const text = readFileSync(path, "utf8");
    return text.includes("\u0000") ? "binary" : text;
  } catch {
    return null;
  }
}

/** A script file run by the command: checked like a line of its own. */
function checkScriptFile(word: ShellWord, ctx: CommandContext, shell: boolean): GuardVerdict | null {
  const text = readScriptFile(word, ctx.cwd);
  if (text === null || text === "binary") return null;
  return (
    checkText(text, text) ??
    (shell ? checkLineCommands(text, { ...ctx, depth: ctx.depth + 1 }) : null)
  );
}

function checkText(raw: string, osascriptSource: string): GuardVerdict | null {
  const text = raw.normalize("NFKC").toLowerCase();
  for (const problem of LINE_PROBLEMS) {
    if (problem.test.test(text)) return refuse(problem.what);
  }
  if (SCRIPTING_CONTEXT.test(text)) {
    let rest = text;
    for (const allowed of QUIT_OR_ACTIVATE) rest = rest.replace(allowed, " ");
    for (const problem of SCRIPT_PROBLEMS) {
      if (problem.test.test(rest)) return refuse(problem.what);
    }
    const hidden = hiddenOsascriptSource(osascriptSource.normalize("NFKC").toLowerCase());
    if (hidden !== null) return refuse(hidden);
  }
  return null;
}

/**
 * `osascript` reading a script this cannot see: piped in from anything
 * but `echo` / `printf`, or redirected from a file. (A file operand is
 * caught per command.) A heredoc or here-string is part of the line.
 */
function hiddenOsascriptSource(text: string): string | null {
  const piped = /\|\s*(?:\S*\/)?osascript\b/.test(text);
  if (piped && !/(?:^|[;&|(]\s*)(?:echo|printf)\b[^|;&]*\|\s*(?:\S*\/)?osascript\b/.test(text)) {
    return "a script piped into osascript from somewhere this cannot read";
  }
  if (/\bosascript\b[^|;&\n]*(?<!<)<(?![<(])/.test(text)) {
    return "a script read into osascript from a file";
  }
  return null;
}

function checkLineCommands(line: string, ctx: CommandContext): GuardVerdict | null {
  if (ctx.depth > 4) return null;
  const tokens = lexShellLine(line, "posix");
  if (tokens === null) return null;
  let words: ShellWord[] = [];
  const flush = (): GuardVerdict | null => {
    const verdict = words.length > 0 ? checkCommand(words, ctx) : null;
    words = [];
    return verdict;
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.kind === "word") {
      words.push(token);
      continue;
    }
    if (token.kind === "redirect") {
      k += 1;
      continue;
    }
    const verdict = flush();
    if (verdict) return verdict;
  }
  return flush();
}

function checkCommand(all: readonly ShellWord[], outer: CommandContext): GuardVerdict | null {
  // The words as the shell passes them on, quotes taken off: `osa''script`.
  const dequoted = all.map((word) => word.text).join(" ");
  const asText = checkText(dequoted, dequoted);
  if (asText) return asText;
  const ctx = { ...outer };
  let i = 0;
  while (i < all.length) {
    const word = all[i]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["!", "{", "if", "then", "else", "elif", "while", "until", "do"].includes(word)) {
      i += 1;
      continue;
    }
    const name = basenameCommand(word).toLowerCase();
    const valueFlags = PREFIX_COMMANDS[name];
    if (valueFlags === undefined) break;
    if (name === "xargs") ctx.viaXargs = true;
    i += 1;
    while (i < all.length) {
      const next = all[i]!.text;
      if (name === "env" && (next === "-S" || next === "--split-string")) {
        const split = all[i + 1];
        return split ? checkLineCommands(split.text, { ...ctx, depth: ctx.depth + 1 }) : null;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next) && name === "env") {
        i += 1;
        continue;
      }
      if (!next.startsWith("-")) break;
      i += valueFlags.includes(next) ? 2 : 1;
    }
    // `timeout 5 cmd`, `watch -n 1 cmd`: the duration comes first.
    if ((name === "timeout" || name === "gtimeout") && /^\d/.test(all[i]?.text ?? "")) i += 1;
    if (name === "arch" && /^-/.test(all[i]?.text ?? "")) i += 1;
  }
  const head = all[i];
  if (head === undefined) return null;
  const name = basenameCommand(head.text).toLowerCase();
  const args = all.slice(i + 1);

  if (NESTED_SHELLS.has(name)) {
    for (let j = 0; j < args.length; j++) {
      const flag = args[j]!.text;
      if (!flag.startsWith("-")) return checkScriptFile(args[j]!, ctx, true);
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) {
        const script = args[j + 1];
        return script ? checkText(script.text, script.text) ?? checkLineCommands(script.text, { ...ctx, depth: ctx.depth + 1 }) : null;
      }
    }
    return null;
  }
  if (name !== "osascript" && SCRIPT_RUNNERS.test(name)) {
    const file = args.find((a) => !a.text.startsWith("-"));
    // `python3 -c "…"` / `node -e "…"` are inline: the line's own text was checked.
    if (file === undefined || args.some((a) => /^-[a-zA-Z]*[ce]$/.test(a.text) || a.text === "-m")) return null;
    return checkScriptFile(file, ctx, false);
  }
  if (/[/\\]/.test(head.text) && !isBrowserExecutable(head.text)) {
    // `./run.sh`: an executable script is read like `bash run.sh`.
    const verdict = checkScriptFile(head, ctx, true);
    if (verdict) return verdict;
  }
  if (name === "eval") {
    const line = args.map((a) => a.text).join(" ");
    return checkText(line, line) ?? checkLineCommands(line, { ...ctx, depth: ctx.depth + 1 });
  }
  if (name === "find") {
    // `find … -exec open -a Safari {} \;`: the words after `-exec` are a command.
    const at = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
    if (at === -1) return null;
    const end = args.findIndex((a, k) => k > at && (a.text === ";" || a.text === "+"));
    return checkCommand(args.slice(at + 1, end === -1 ? undefined : end), { ...ctx, viaXargs: true });
  }
  if (name === "open") return checkMacOpen(args, ctx);
  if (["xdg-open", "gnome-open", "kde-open", "kde-open5", "wslview", "start", "explorer", "explorer.exe"].includes(name)) {
    return checkOpener(args, ctx);
  }
  if (name === "gio" && args[0]?.text === "open") return checkOpener(args.slice(1), ctx);
  if (["sensible-browser", "x-www-browser", "www-browser", "gnome-www-browser"].includes(name)) {
    return refuse("starting the default web browser");
  }
  if ((name === "rundll32" || name === "rundll32.exe") && args.some((a) => /url\.dll|ieframe\.dll|shdocvw/i.test(a.text))) {
    return refuse("opening a web address in the browser");
  }
  if (isBrowserExecutable(head.text)) {
    const meaningful = args.filter((a) => !/^--?(?:version|help|v)$/i.test(a.text));
    if (meaningful.length > 0 || ctx.viaXargs) return refuse("running a web browser's program with arguments");
    return null;
  }
  if (name === "osascript") return checkOsascriptArgs(args, ctx);
  if (name === "source" || name === ".") return args[0] ? checkScriptFile(args[0], ctx, true) : null;
  if (["cliclick", "wtype"].includes(name)) return refuse("synthesised keystrokes or clicks");
  if (["xdotool", "ydotool"].includes(name) && args.some((a) => /^(?:type|key|keydown|keyup|click|mousedown|mouseup|mousemove)$/.test(a.text))) {
    return refuse("synthesised keystrokes or clicks");
  }
  return null;
}

function isBrowserExecutable(path: string): boolean {
  const lower = path.toLowerCase();
  if (BROWSER_BINARY.test(basenameCommand(lower))) return true;
  const bundle = /([^/]+)\.app\/contents\/macos\//.exec(lower);
  return bundle !== null && BROWSER_APP_NAME.test(bundle[1]!);
}

/** macOS `open`: `-a`/`-b` name the app, `-u` a URL, the rest are files or URLs. */
function checkMacOpen(args: readonly ShellWord[], ctx: CommandContext): GuardVerdict | null {
  const valueFlags = new Set(["-a", "-b", "-s", "--env", "--stdin", "--stdout", "--stderr", "-u"]);
  let app: ShellWord | null = null;
  let bundle: ShellWord | null = null;
  let reveal = false;
  let toEditor = false;
  let appArgs = false;
  const operands: ShellWord[] = [];
  for (let j = 0; j < args.length; j++) {
    const word = args[j]!;
    const text = word.text;
    if (text === "--args") {
      appArgs = j + 1 < args.length;
      break;
    }
    if (text === "-u" || text === "--url") return refuse("opening a web address in the browser");
    if (valueFlags.has(text)) {
      const value = args[j + 1];
      if (text === "-a") app = value ?? null;
      if (text === "-b") bundle = value ?? null;
      j += 1;
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      if (/^-[a-zA-Z]*R/.test(text)) reveal = true;
      if (/^-[a-zA-Z]*[et]/.test(text)) toEditor = true;
      continue;
    }
    operands.push(word);
  }
  if (reveal) return null;
  const toBrowser =
    (app !== null && (app.dynamic || isBrowserAppName(app.text))) ||
    (bundle !== null && (bundle.dynamic || isBrowserBundleId(bundle.text)));
  if (toBrowser && (operands.length > 0 || appArgs || ctx.viaXargs)) {
    return refuse("handing a page, file or arguments to a web browser");
  }
  if (toBrowser) return null;
  const otherApp = app !== null || bundle !== null || toEditor;
  for (const word of operands) {
    if (WEB_SCHEME.test(word.text.trim()) || BARE_HOST.test(word.text.trim())) {
      if (!otherApp || /^(?:https?|ftp|file|javascript|data):/i.test(word.text.trim())) {
        return refuse("opening a web address in the browser");
      }
    }
    if (!otherApp && WEB_FILE.test(word.text.trim())) return refuse("opening a web page file in the browser");
    if (!otherApp && word.dynamic) return refuse("opening something only known at run time (it may be a web address)");
  }
  if (!otherApp && ctx.viaXargs) return refuse("opening something only known at run time (it may be a web address)");
  return null;
}

/** `xdg-open`, `start`, `explorer` …: a web URL, web file or unknown operand goes to the browser. */
function checkOpener(args: readonly ShellWord[], ctx: CommandContext): GuardVerdict | null {
  const operands = args.filter((a) => !a.text.startsWith("-") && !/^\/[a-z?]+$/i.test(a.text));
  if (operands.some((a) => a.dynamic || isWebTarget(a))) return refuse("opening a web address or web page in the browser");
  if (ctx.viaXargs) return refuse("opening something only known at run time (it may be a web address)");
  return null;
}

/** `osascript` with a script file it would read: that text cannot be checked here. */
function checkOsascriptArgs(args: readonly ShellWord[], ctx: CommandContext): GuardVerdict | null {
  let inline = false;
  for (let j = 0; j < args.length; j++) {
    const text = args[j]!.text;
    // After an inline script the rest are its `argv`.
    if (inline && !text.startsWith("-")) break;
    if (text === "-e") {
      inline = true;
      if (args[j + 1]?.dynamic) return refuse("a script built at run time, so it cannot be checked");
      j += 1;
      continue;
    }
    if (text === "-l" || text === "-s") {
      j += 1;
      continue;
    }
    if (/^-[a-zA-Z]*$/.test(text)) {
      if (text === "-") return refuse("a script read into osascript from somewhere this cannot read");
      continue;
    }
    const script = readScriptFile(args[j]!, ctx.cwd);
    if (script === null || script === "binary") {
      return refuse("an osascript script file that cannot be read here (pass the script inline with -e so it can be checked)");
    }
    return checkText(`osascript\n${script}`, script);
  }
  if (ctx.viaXargs) return refuse("a script read into osascript from somewhere this cannot read");
  return null;
}
