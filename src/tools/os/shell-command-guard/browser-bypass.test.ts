import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_BYPASS_RULE,
  checkBrowserBypassArgv,
  checkBrowserBypassLine,
} from "./browser-bypass.js";

/**
 * ATO-1260: the shell does not drive web browsers. The first block of
 * cases must keep running (quitting / starting a browser, ordinary dev
 * commands); the rest are the forms a model used, or could use, to reach
 * a page without the browser tool's asks.
 */
let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "atomic-browser-bypass-"));
  await writeFile(join(cwd, "evil.sh"), 'osascript -e "tell application \\"Safari\\" to get URL of front document"\n');
  await writeFile(join(cwd, "s.applescript"), 'tell application "Google Chrome" to get URL of active tab of front window\n');
  await writeFile(join(cwd, "ok.applescript"), 'display notification "hi"\n');
  await writeFile(join(cwd, "open.py"), 'import subprocess\nsubprocess.run(["open", "-a", "Safari", "https://x.com"])\n');
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const CASES: [string, boolean][] = [
 [`osascript -e 'tell application "Google Chrome" to quit'`, false],
 [`osascript -e 'quit app "Safari"'`, false],
 [`osascript -e 'tell application "Google Chrome" to activate'`, false],
 [`osascript -e 'tell application "Safari"' -e 'quit' -e 'end tell'`, false],
 [`osascript -l JavaScript -e 'Application("Google Chrome").quit()'`, false],
 [`osascript -e 'display notification "Done" with title "Agent"'`, false],
 [`osascript -e 'tell application "Finder" to get name of every disk'`, false],
 [`osascript -e 'set volume output volume 50'`, false],
 [`open -a "Google Chrome"`, false],
 [`open -a Safari`, false],
 [`open .`, false],
 [`open ~/Downloads/report.pdf`, false],
 [`open -a "Visual Studio Code" .`, false],
 [`open -R ~/Downloads/index.html`, false],
 [`killall "Google Chrome"`, false],
 [`brew install --cask google-chrome`, false],
 [`git clone https://github.com/a/b && cd b && npm install`, false],
 [`npm run build && npx playwright test`, false],
 [`curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash`, false],
 [`echo hello | grep h`, false],
 [`osascript ok.applescript`, false],
 [`osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "https://mail.google.com"'`, true],
 [`osascript -e 'tell application "Google Chrome" to make new tab at end of tabs of front window with properties {URL:"https://x.com"}'`, true],
 [`osascript -e 'tell application "Google Chrome" to get {URL, title} of active tab of front window'`, true],
 [`open -a "Google Chrome" "https://mail.google.com/mail/u/0/"`, true],
 [`open https://mail.google.com`, true],
 [`open -b com.google.Chrome x`, true],
 [`open -u https://x.com`, true],
 [`open link.webloc`, true],
 [`open index.html`, true],
 [`sh -c 'open -a Safari https://x.com'`, true],
 [`bash -lc "osascript -e 'tell app \\"Safari\\" to get URL of front document'"`, true],
 [`env FOO=1 open -a Arc https://x.com`, true],
 [`echo https://x.com | xargs open`, true],
 [`osascript <<< 'tell application "Safari" to get URL of document 1'`, true],
 [`osascript <<EOF\ntell application "Safari" to do JavaScript "1" in document 1\nEOF`, true],
 [`osascript -e 'tell application "System Events" to keystroke "l" using command down'`, true],
 [`osascript -e 'open location "https://x.com"'`, true],
 [`osascript -l JavaScript -e 'Application("Safari").documents[0].url()'`, true],
 [`osascript -e 'tell application ("Saf" & "ari") to get URL of document 1'`, true],
 [`osa''script -e 'tell app "Safari" to get URL of document 1'`, true],
 [`cat x.applescript | osascript`, true],
 [`osascript s.applescript`, true],
 [`bash evil.sh`, true],
 [`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless https://x.com`, true],
 [`google-chrome https://x.com`, true],
 [`python3 -m webbrowser https://x.com`, true],
 [`python3 -c "import webbrowser; webbrowser.open('https://x.com')"`, true],
 [`shortcuts run "Open Mail"`, true],
 [`defaults write com.apple.Safari HomePage https://x.com`, true],
 [`curl -s http://127.0.0.1:9222/json/new?https://x.com`, true],
 [`echo b3BlbiBodHRwczovL3guY29t | base64 -d | sh`, true],
 [`find . -name x.webloc -exec open {} \;`, true],
 [`timeout 5 open -a "Brave Browser" https://x.com`, true],
 [`sudo -u me open https://x.com`, true],
 [`perl -e 'system("open", "https://x.com")'`, true],
 [`xdg-open https://x.com`, true],
];

describe("checkBrowserBypassLine", () => {
  it.each(CASES.filter(([, refused]) => !refused))("runs: %s", (line) => {
    expect(checkBrowserBypassLine(line, cwd)).toBeNull();
  });

  it.each(CASES.filter(([, refused]) => refused))("refuses: %s", (line) => {
    const verdict = checkBrowserBypassLine(line, cwd);
    expect(verdict).toMatchObject({ action: "block", rule: BROWSER_BYPASS_RULE });
    expect(verdict?.reason).toContain("use the browser tool");
  });

  it("reads a Python script it is asked to run", () => {
    expect(checkBrowserBypassLine("python3 open.py", cwd)).not.toBeNull();
  });
});

describe("checkBrowserBypassArgv", () => {
  it("refuses the argv forms from the incident", () => {
    expect(
      checkBrowserBypassArgv("osascript", ["-e", 'tell application "Google Chrome" to get {URL, title} of active tab of front window'], cwd),
    ).not.toBeNull();
    expect(checkBrowserBypassArgv("open", ["-a", "Google Chrome", "https://mail.google.com/"], cwd)).not.toBeNull();
  });

  it("keeps quit, start and non-browser opens", () => {
    expect(checkBrowserBypassArgv("osascript", ["-e", 'tell application "Google Chrome" to quit'], cwd)).toBeNull();
    expect(checkBrowserBypassArgv("open", ["-a", "Google Chrome"], cwd)).toBeNull();
    expect(checkBrowserBypassArgv("open", ["-a", "Preview", "a.pdf"], cwd)).toBeNull();
    expect(checkBrowserBypassArgv("git", ["status"], cwd)).toBeNull();
  });
});
