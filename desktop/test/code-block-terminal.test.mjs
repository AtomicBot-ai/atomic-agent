// ATO-1426: a shell code block gets "Open in Terminal" next to Copy, on macOS
// only for now (ATO-1422), and only when the preload has the bridge.
// codeBlockFrame and codeBlockTerminalOk are read from renderer.js as text
// and run in a vm context with their neighbours stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
/** codeBlockFrame on `platform`, with a bridge that has terminalOpenWithCommand unless `bridge` says otherwise. */
function frame(platform, bridge = { terminalOpenWithCommand() { return Promise.resolve({ ok: true, cwd: "/tmp", usedHome: false }); } }) {
  const c = vm.createContext({ BR: bridge });
  vm.runInContext("const PLATFORM = " + JSON.stringify(platform) + ";\n"
    + "function ic(n) { return '<i data-ic=\"' + n + '\"></i>'; }\n"
    + fn("codeBlockFrame") + fn("codeBlockTerminalOk")
    + "globalThis.codeBlockFrame = codeBlockFrame;", c);
  return c.codeBlockFrame;
}
const pre = (lang, code = "ls -la", open = false) =>
  '<pre class="mdpre"' + (open ? ' data-open="1"' : "") + (lang ? ' data-lang="' + lang + '"' : "") + "><code>" + code + "</code></pre>";

test("a bash, sh, zsh, shell or console block gets the button on macOS, next to Copy", () => {
  const f = frame("darwin");
  for (const lang of ["bash", "sh", "zsh", "shell", "console", "Bash"]) {
    const h = f(pre(lang));
    assert.match(h, /<button class="mdcopy mdterm" data-mdterm [^>]*><i data-ic="term"><\/i><span>Open in Terminal<\/span><\/button><button class="mdcopy" data-mdcopy/, lang);
  }
});

test("a js, python or unnamed block has no button", () => {
  const f = frame("darwin");
  for (const lang of ["js", "python", "ts", "powershell", ""]) {
    const h = f(pre(lang));
    assert.doesNotMatch(h, /data-mdterm/, lang || "(none)");
    assert.match(h, /data-mdcopy/, "Copy stays");
  }
});

test("off macOS there is no button, until the platform list says otherwise", () => {
  for (const platform of ["win32", "linux"]) assert.doesNotMatch(frame(platform)(pre("bash")), /data-mdterm/, platform);
});

test("an older preload without the bridge, or the demo with none, shows no button", () => {
  assert.doesNotMatch(frame("darwin", {})(pre("bash")), /data-mdterm/);
  assert.doesNotMatch(frame("darwin", null)(pre("bash")), /data-mdterm/);
});

test("a fence still streaming has no button yet", () => {
  assert.doesNotMatch(frame("darwin")(pre("bash", "ls", true)), /data-mdterm/);
});

test("the click sends the block's text as Copy reads it, with the working folder", () => {
  const at = source.indexOf("const mdterm = t.closest('[data-mdterm]');");
  assert.ok(at >= 0, "the click handler is in renderer.js");
  const body = source.slice(at, source.indexOf("\n    return;\n  }\n", at));
  assert.match(body, /textContent\.replace\(\/\\r\\n\?\/g, '\\n'\)\.replace\(\/\\n\$\/, ''\)/);
  assert.match(body, /BR\.terminalOpenWithCommand\(\{ command: text, cwd: workingDir\(\) \|\| null \}\)/);
  assert.match(body, /toast\("Couldn't open Terminal"/);
  // Anything but {ok:true} is a failure, and main's message goes into the toast.
  assert.match(body, /if \(!r \|\| r\.ok !== true\) fail\(r && r\.message\)/);
});

test("the button uses ATO-1424's one preload bridge for terminal:openWithCommand", () => {
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.equal(preload.split('"terminal:openWithCommand"').length - 1, 1, "one bridge for the channel");
  assert.match(preload, /terminalOpenWithCommand: \(req: \{ command: string; cwd\?: string \| null \}\) => ipcRenderer\.invoke\("terminal:openWithCommand", req\)/);
  assert.doesNotMatch(preload, /openInTerminal/);
});
