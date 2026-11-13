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
  // `$((…))` is arithmetic: lifted before the lexer reads the rest of the file.
  await writeFile(join(cwd, "sign-in.sh"), "#!/bin/sh\ni=$((1+1))\necho 'To sign in, open https://example.test/device and enter ABCD-1234'\n");
  await writeFile(join(cwd, "opens.sh"), "#!/bin/sh\ni=$((1+1))\necho 'starting'\nopen https://x.com\n");
  await writeFile(join(cwd, "open.py"), 'import subprocess\nsubprocess.run(["open", "-a", "Safari", "https://x.com"])\n');
  await writeFile(join(cwd, "sign-in.py"), 'code = "ABCD-1234"\nprint(f"To sign in, open https://example.test/device and enter {code}")\n');
  await writeFile(join(cwd, "sign-in.js"), 'console.log("To sign in, open https://example.test/device and enter ABCD-1234");\n');
  await writeFile(join(cwd, "prints.py"), 'print("open https://x.com")\n');
  await writeFile(join(cwd, "prints.js"), 'console.log("open https://x.com");\n');
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
 [`echo 'To sign in, open https://example.test/device and enter the code'`, false],
 [`printf "open https://example.test/device\\n" >&2`, false],
 [`./sign-in.sh`, false],
 // ATO-1349 / ATO-1353: a script that only prints a sign-in hint is not a browser launch.
 [`echo 'To sign in,' "open https://example.test/device"`, false],
 [`printf '%s\\n' 'open https://example.test/device'`, false],
 [`bash <<'EOF'\necho "open https://example.test/device and enter the code"\nEOF`, false],
 [`python3 -c 'print("To sign in, open https://example.test/device and enter ABCD-1234")'`, false],
 [`python3 -c "print(\\"open https://example.test/device\\")"`, false],
 [`python3 -c 'import sys; sys.stdout.write("open https://example.test/device\\n")'`, false],
 [`python3 -c 'code = "ABCD"; print(f"Open https://example.test/device and enter {code}")'`, false],
 [`python3 <<'EOF'\nprint("""Open https://example.test/device\nand enter the code""")\nEOF`, false],
 [`node -e 'console.log("open https://example.test/device")'`, false],
 [`node -e 'const c = "ABCD"; console.log(\`Open https://example.test/device and enter \${c}\`)'`, false],
 [`node -e 'process.stdout.write("open https://example.test/device\\n")'`, false],
 [`python3 sign-in.py`, false],
 [`node sign-in.js`, false],
 [`osascript ok.applescript`, false],
 // ATO-1468: substitutions that do not reach a browser.
 [`cd "$(git rev-parse --show-toplevel)" && npm test`, false],
 [`open -a Preview "$(ls *.pdf | head -1)"`, false],
 [`echo "built at $(date)"`, false],
 [`cmd /c dir`, false],
 [`cmd /c "dir"`, false],
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
 // ATO-1468: the address comes from a command substitution or a variable.
 [`open "$(python3 x.py)"`, true],
 [`open \`python3 x.py\``, true],
 [`open -a Safari "$(python3 x.py)"`, true],
 [`xdg-open "$(node url.js)"`, true],
 [`wslview $(cat url.txt)`, true],
 [`start "$(python3 x.py)"`, true],
 [`explorer.exe "$(python3 x.py)"`, true],
 [`URL=$(python3 x.py); open "$URL"`, true],
 [`cd "$(git rev-parse --show-toplevel)" && open "$(python3 x.py)"`, true],
 [`x=$(sh -c 'open -a Safari https://x.com')`, true],
 [`cmd /c start https://x.com`, true],
 [`cmd.exe /C start "" "$(python3 x.py)"`, true],
 [`cmd /c "start https://x.com"`, true],
 [`cmd.exe /k "start \"\" https://x.com"`, true],
 [`echo 'open https://x.com' | sh`, true],
 [`echo 'open https://x.com' > run.sh`, true],
 [`echo hi; open https://x.com`, true],
 [`./opens.sh`, true],
 [`python3 -c 'import subprocess; subprocess.run(["open", "https://x.com"])'`, true],
 [`python3 -c 'import os; print(os.system("open https://x.com"))'`, true],
 [`python3 -c 'print("hi"); import os; os.system("open https://x.com")'`, true],
 [`python3 -c 'print("open https://x.com")' | sh`, true],
 [`node -e 'require("child_process").exec("open https://x.com")'`, true],
 [`node -e 'console.log("hi"); require("child_process").execSync("xdg-open https://x.com")'`, true],
 [`node -e 'console.log(\`\${require("child_process").execSync("open https://x.com")}\`)'`, true],
 [`echo 'hi' "open https://x.com" | sh`, true],
 // What a script prints, carried on to something that runs it.
 [`python3 prints.py | sh`, true],
 [`node prints.js | sh`, true],
 [`python3 prints.py > run.sh`, true],
 [`bash -c 'python3 prints.py | xargs open'`, true],
 // A print name rebound to something that runs commands.
 [`python3 -c 'import os; print = os.system; print("open https://x.com")'`, true],
 [`node -e 'console.log = require("child_process").execSync; console.log("open https://x.com")'`, true],
 [`python3 -c 'import os,types; log=types.SimpleNamespace(info=os.system); log.info("open https://x.com")'`, true],
 [`python3 -c 'import subprocess; print("open https://x.com", file=subprocess.Popen(["sh"],stdin=-1,text=True).stdin)'`, true],
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
