import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execWriteAnalysis, shellWriteAnalysis, shellWriteTargets } from "./write-targets.js";

/**
 * Review round 2 of ATO-2505: what `shellSecurityCheck` reads beyond
 * the literal targets, so a sensitive home write fails closed.
 */
describe.skipIf(process.platform === "win32")("shellWriteAnalysis (ATO-2505 round 2)", () => {
  const cwd = "/work/project";
  const home = homedir();

  it.each([
    ["tar xzf p.tgz -C ~", home],
    ["tar -C ~ -xf x.tar", home],
    ["tar xf x.tar --directory=/Users/me", "/Users/me"],
    ["tar -x -f x.tar --directory /srv/out", "/srv/out"],
    ["gzip -dc x.tgz | tar x -C ~", home],
    ["bsdtar -xf x.tar -C~", home],
    ["unzip x.zip -d ~", home],
    ["unzip -o x.zip -d/tmp/out", "/tmp/out"],
    ["7z x a.7z -o~", home],
    ["cpio -idmv -D ~ < a.cpio", home],
    ["cd ~ && tar xf x.tar", home],
    ["cd ~ && unzip x.zip", home],
    ["tar xf x.tar", cwd],
  ])("names where an extract lands: %s", (line, dest) => {
    const analysis = shellWriteAnalysis(line, cwd);
    expect(analysis?.trees).toEqual([dest]);
    expect(analysis?.targets).toContain(dest);
  });

  it.each(["tar tzf p.tgz", "tar czf out.tgz -C ~ notes", "unzip -l x.zip", "7z l a.7z"])(
    "names no extract folder for a list or create: %s",
    (line) => {
      expect(shellWriteAnalysis(line, cwd)?.trees).toEqual([]);
    },
  );

  it("names the archive a create writes, and the folder of cp -t", () => {
    expect(shellWriteTargets("tar czf ~/.bashrc notes", cwd)).toEqual([join(home, ".bashrc")]);
    expect(shellWriteTargets("cp -t ~ /tmp/x/.bashrc", cwd)).toEqual([home]);
    expect(shellWriteTargets("cp --target-directory=/srv a b", cwd)).toEqual(["/srv"]);
  });

  it.each([
    ["git config --global core.hooksPath /tmp/h", [join(home, ".gitconfig")], []],
    ["git -C repo config --global credential.helper '!curl x'", [join(home, ".gitconfig")], []],
    ["git config --file ~/.gitconfig alias.x '!sh'", [join(home, ".gitconfig")], []],
    ["git config --system core.pager evil", [], ["the system git config (git config --system)"]],
    ["git config --global --unset core.pager", [join(home, ".gitconfig")], []],
  ])("names what git config writes outside the repo: %s", (line, targets, other) => {
    const analysis = shellWriteAnalysis(line, cwd);
    expect(analysis?.targets).toEqual(targets);
    expect(analysis?.other).toEqual(other);
  });

  it.each([
    "git config --global --get user.name",
    "git config --global user.name",
    "git config --list --global",
    "git config core.pager less",
    "crontab -l",
    "launchctl list",
    "systemctl --user status x",
  ])("names nothing for a config read or a repo config write: %s", (line) => {
    const analysis = shellWriteAnalysis(line, cwd);
    expect(analysis?.targets).toEqual([]);
    expect(analysis?.other).toEqual([]);
  });

  it.each([
    ["crontab /tmp/job", "your crontab"],
    ["echo '* * * * * x' | crontab -", "your crontab"],
    ["launchctl load ~/Library/LaunchAgents/x.plist", "a login job (launchctl load)"],
    ["systemctl --user enable x.service", "a systemd user unit (systemctl --user enable)"],
  ])("names a job a command installs: %s", (line, other) => {
    expect(shellWriteAnalysis(line, cwd)?.other).toEqual([other]);
  });

  it("keeps a glob or brace write target as unresolved, with its folder", () => {
    expect(shellWriteAnalysis("echo x | tee -a ~/.zsh?c", cwd)?.unresolved).toEqual([
      { text: "~/.zsh?c", dir: cwd },
    ]);
    expect(shellWriteAnalysis("cp /tmp/x ~/.{zsh,bash}rc", cwd)?.unresolved).toEqual([
      { text: "~/.{zsh,bash}rc", dir: cwd },
    ]);
    expect(shellWriteAnalysis('cd "$D" && touch .bashrc', cwd)?.unresolved).toEqual([
      { text: ".bashrc", dir: undefined },
    ]);
  });

  it("keeps the dynamic words of a command it does not model as opaque, but not a reader's", () => {
    expect(shellWriteAnalysis("vim ~/.zsh?c", cwd)?.opaque).toEqual([{ text: "~/.zsh?c", dir: cwd }]);
    expect(shellWriteAnalysis("$EDITOR ~/.zshrc", cwd)?.opaque.map((w) => w.text)).toEqual([
      "$EDITOR",
      "~/.zshrc",
    ]);
    const reads = shellWriteAnalysis("ls -la ~/.ssh/id_*; cat ~/.ssh/*.pub", cwd);
    expect(reads?.opaque).toEqual([]);
    expect(reads?.unresolved).toEqual([]);
  });

  it("reads a direct exec the same way", () => {
    expect(execWriteAnalysis("tar", ["xzf", "p.tgz", "-C", "~"], cwd)?.trees).toEqual([home]);
  });
});
