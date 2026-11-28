import { isShowOnceAction, type ShowOnceStep } from "./show-once-log.js";
import type { ShowOnceTidy } from "./show-once-tidy.js";

/**
 * ATO-2401 "Show once": a recorded step log (show-once-log.ts) as a
 * SKILL.md the agent replays with its os.screen tools
 * (src/tools/os/screen: elements, press, click, key, type). Pure and
 * deterministic: the same log and date give the same file, so the test
 * pins it and the person reviews exactly what is saved.
 *
 * The file has to pass the agent's gate for a learned skill
 * (src/skills/learning/skill-lint.ts and the security scan) when the draft
 * is approved: a kebab-case name equal to the folder, a one-line
 * description of at most 300 characters, a body of at least 40 characters
 * and no scripts. The name carries the minute it was recorded, so two
 * recordings never ask for the same folder.
 */

export interface CompiledShowOnceSkill {
  name: string;
  description: string;
  content: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `show-once-<app>-<yyyymmdd>-<hhmm>`, local time, within the 64-character name rule. */
export function showOnceSkillName(firstApp: string | null, at: Date): string {
  const slug = String(firstApp || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "") || "app";
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `show-once-${slug}-${stamp}`;
}

/** The apps a log works in, in order of first use, protected ones left out. */
export function showOnceApps(steps: readonly ShowOnceStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (s.kind === "app" && !out.includes(s.app)) out.push(s.app);
  return out;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  AXButton: "button", AXMenuItem: "menu item", AXMenuBarItem: "menu", AXMenuButton: "menu button",
  AXPopUpButton: "pop-up menu", AXCheckBox: "checkbox", AXRadioButton: "option", AXTab: "tab",
  AXTextField: "text field", AXSearchField: "search field", AXComboBox: "combo box", AXTextArea: "text area",
  AXDisclosureTriangle: "disclosure triangle", AXSlider: "slider", AXIncrementor: "stepper", AXRow: "row",
  AXCell: "cell", AXLink: "link", AXImage: "icon", AXStaticText: "text", AXSecureTextField: "password field",
};

function roleWord(role: string): string {
  return ROLE_WORDS[role] ?? "control";
}

function at(offset: { x: number; y: number } | null): string {
  return offset ? ` Recorded at (${offset.x}, ${offset.y}) from the window's top-left corner, a hint only.` : "";
}

/** A recorded menu path as the skill writes it: **File > Export To > PDF**. */
function menuPath(path: readonly string[]): string {
  return `**${path.join(" > ")}**`;
}

/** One step as an instruction line, or null for a step that says nothing on its own. */
export function stepLine(s: ShowOnceStep): string | null {
  switch (s.kind) {
    case "app":
      return s.browser
        ? `Switch to **${s.app}** (\`${s.bundleId}\`). It is a web browser: do this part with the browser tool, since os.screen only looks at browsers.`
        : `Switch to **${s.app}** (\`${s.bundleId}\`); open it first if it is not running.`;
    case "click": {
      const verb = s.button === "right" ? "Right-click" : s.double ? "Double-click" : "Click";
      const el = s.element;
      if (el && el.role === "AXSecureTextField") return `${verb} the password field.${at(s.offset)}`;
      const what = el ? (el.label ? `the ${roleWord(el.role)} "${el.label}"` : `a ${roleWord(el.role)}`) : "a spot in the window";
      const how = el && el.label && s.button === "left" && !s.double
        ? " Find it with os.screen.elements and press it with os.screen.press."
        : " Find it with os.screen.elements or os.screen.capture, then os.screen.click.";
      return `${verb} ${what} in ${s.app}.${how}${at(s.offset)}`;
    }
    case "keys":
      return `Press \`${s.keys}\` in ${s.app} (os.screen.key { keys: "${s.keys}" }).${s.menu ? ` It runs the menu command ${menuPath(s.menu)}.` : ""}`;
    case "menu":
      return `Choose ${menuPath(s.path)} from the menu bar in ${s.app}. Open each menu in turn: find it with os.screen.elements and press it with os.screen.press.`;
    case "text":
      return s.secure
        ? `A password goes here in ${s.app}. Never type it: ask the user to type it themselves, then go on.`
        : `Type the text for this step${s.into ? ` into the field "${s.into}"` : ""} in ${s.app} (os.screen.type). It was not recorded: take it from the task or ask the user.`;
    case "protected":
      return `The recording paused in ${s.app} (a protected app the agent cannot control). Ask the user to do this part themselves.`;
  }
}

/**
 * ATO-2499 replay check: what the screen should show once step `i` is done,
 * from the window titles the recording heard (show-once-log.ts `window` /
 * `after`). '' when the recording knows nothing to compare (no helper, a
 * browser, a protected app).
 */
export function stepCheck(steps: readonly ShowOnceStep[], i: number): string {
  const s = steps[i];
  if (!s) return "";
  if (s.kind === "app") {
    const next = steps.slice(i + 1).find(isShowOnceAction);
    return !s.browser && next && next.bundleId === s.bundleId && next.window ? ` Check: ${s.app} is in front with the window "${next.window}".` : "";
  }
  if (!isShowOnceAction(s)) return "";
  const want = s.after ?? s.window;
  if (!want) return "";
  return s.after ? ` Check: the window "${want}" is now in front.` : ` Check: the window "${want}" is still in front.`;
}

/** The step lines of a log with their checks, numbered as the SKILL.md numbers them (line i is step i + 1). */
export function showOnceStepLines(steps: readonly ShowOnceStep[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    const line = stepLine(s);
    if (line !== null) out.push(line + stepCheck(steps, i));
  });
  return out;
}

/**
 * The SKILL.md for a log, recorded at `recordedAt`. Null when the log has
 * no step a person did. ATO-2499 `tidy`: the chat model's title,
 * description, summary and inputs (show-once-tidy.ts, already checked); the
 * steps stay as recorded either way.
 */
/**
 * ATO-2499 Windows and Linux: there the agent's os.screen tools only take
 * pictures (no elements, press, click, key or type), so the replay is the
 * agent walking the user through each step and checking a capture after it.
 */
function replayRules(os: string): string[] {
  if (os === "macOS") {
    return [
      "- This runs on macOS with the os.screen tools. Before a step, list the window's controls with `os.screen.elements { app }` and press the matching one with `os.screen.press { app, element }`. Use `os.screen.click` only when no control matches.",
      "- Replay check: after each step, look at the window (`os.screen.elements { app }` names it and its controls, or `os.screen.capture { app }`) and compare it with the step's \"Check:\" line, or with what the next step needs when there is none.",
    ];
  }
  return [
    `- This was recorded on ${os}. There the os.screen tools can only take a picture of the screen (\`os.screen.capture\`), not click or type, so walk the user through it: tell the user one step at a time in plain words (the app, the window, the control's name or where it was), and wait until they say it is done. Keyboard shortcuts are named as recorded (\`ctrl+s\`).`,
    "- Replay check: after each step, take `os.screen.capture` and compare it with the step's \"Check:\" line, or with what the next step needs when there is none.",
  ];
}

/** A step line without the Mac's tool hints, for a person to follow (Windows, Linux). */
export function showOncePlainStep(line: string): string {
  return line
    .replace(/ Find it with .*?os\.screen\.(?:press|click)\./g, "")
    .replace(/ Open each menu in turn: .*?os\.screen\.press\./g, "")
    .replace(/ \(os\.screen\.\w+(?: \{[^}]*\})?\)/g, "");
}

export function compileShowOnceSkill(
  steps: readonly ShowOnceStep[],
  recordedAt: Date,
  tidy?: ShowOnceTidy | null,
  os: string = "macOS",
): CompiledShowOnceSkill | null {
  const acted = steps.some(isShowOnceAction);
  if (!acted) return null;
  const apps = showOnceApps(steps);
  const here = os === "macOS" ? "Mac" : `${os} computer`;
  const where = apps.length === 0 ? `a ${here} app` : apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}`;
  const name = showOnceSkillName(apps[0] ?? null, recordedAt);
  const day = `${recordedAt.getFullYear()}-${pad(recordedAt.getMonth() + 1)}-${pad(recordedAt.getDate())}`;
  const lines = showOnceStepLines(steps).map((l) => (os === "macOS" ? l : showOncePlainStep(l)));
  let description = `Repeat a routine the user showed once in ${where} (${lines.length} steps), with the os.screen tools. Use when the user asks to do that routine again.`;
  if (description.length > 300) description = `Repeat a routine the user showed once on this ${here} (${lines.length} steps), with the os.screen tools.`;
  if (tidy && tidy.description && tidy.description.length <= 300) description = tidy.description;
  const ask = tidy && tidy.inputs.length
    ? ["## Ask the user for", "", "Before starting, ask for anything the request did not give:", "", ...tidy.inputs.map((i) => `- ${i}`), ""]
    : [];
  const body = [
    tidy && tidy.title ? `# ${tidy.title}` : `# Routine shown once in ${where}`,
    "",
    ...(tidy && tidy.summary ? [tidy.summary, ""] : []),
    `The user recorded this routine once with Show once on ${day}. Only clicks, shortcuts, menu commands and which app and window were in front were recorded: typed text and passwords were not, and nothing at all was recorded in protected apps.`,
    "",
    ...ask,
    "## How to replay",
    "",
    ...replayRules(os),
    "- At the first step that does not match, stop: do not try other clicks. Tell the user \"Replay stopped at step N of M: expected ..., saw ...\" and what you think went wrong.",
    "- When every step matched, end with \"Replay check: all M steps matched.\"",
    "- Recorded positions are hints: windows move. Go by the control's name first.",
    "- Never type a password and never act in a protected app; ask the user to do those parts.",
    "- If the user asked for something slightly different from the recording (another file, another value), follow the user.",
    "",
    "## Steps",
    "",
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    "",
  ];
  const content = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", "", ...body].join("\n");
  return { name, description, content };
}
