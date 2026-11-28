import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import type { GuardVerdict } from "../shell-command-guard/index.js";
import { shellSecurityCheck } from "./shell-security-check.js";

const safe = { action: "allow", rule: "safe.echo", reason: "echo" } as GuardVerdict;
const me = userInfo().username;

/**
 * Review round 3 of ATO-2505: forms that still hid a sensitive home
 * write at 7533406. Each line below ran unasked there.
 */
describe("shellSecurityCheck, review round 3 (F2069-R3.1 to R3.5)", () => {
  it.each([
    // F2069-R3.1: `C` bundled in a tar key, `--cd`, a long option prefix.
    "tar xfC x.tar ~",
    "tar xzfC x.tgz $HOME",
    "tar xCf ~ x.tar",
    "tar -xCf ~ x.tar",
    "tar -xzCf ~ x.tgz",
    "tar --cd=~ -xf x.tar",
    "tar --extract -f x.tar --cd ~",
    "tar -xf x.tar --dir=~",
    // F2069-R3.2: `~user`; another user's home is taken as home.
    `tee -a ~${me}/.zshrc`,
    `cp x ~${me}/.ssh/authorized_keys`,
    `cd ~${me} && tar xf /tmp/x.tar`,
    "cp x ~root/.ssh/authorized_keys",
    "echo x >> ~-/.bashrc",
    // F2069-R3.3: ANSI-C and locale quoting.
    "tee -a ~/.zsh$'r'c",
    "echo x >> ~/$'.zshrc'",
    'echo x >> ~/.zsh$"r"c',
    "tee -a ~/.zsh$'\\x72'c",
    "cp x ~/.ss$'\\150'/authorized_keys",
    // F2069-R3.4: PowerShell writers and `$PROFILE`.
    "echo 'iex evil' >> $PROFILE",
    `pwsh -c "Add-Content -Path $PROFILE -Value 'iex evil'"`,
    `pwsh -c "'iex evil' >> $PROFILE"`,
    'pwsh -c "Out-File -Append ~/.ssh/authorized_keys"',
    'pwsh -c "ac ~/.zshrc x"',
    'pwsh -c "Set-Content -Path:~/.gitconfig x"',
    'pwsh -c "Tee-Object -FilePath ~/.bashrc"',
    'pwsh -c "Expand-Archive x.zip -DestinationPath ~"',
    // F2069-R3.5: package manager config.
    "npm config set registry http://evil.example",
    "npm set registry http://evil.example",
    "npm c set registry=http://evil.example",
    "npm config set registry http://evil.example --global",
    "yarn config set registry http://evil.example",
    "pnpm config set registry http://evil.example",
    "pip config set global.index-url http://evil.example",
  ])("forces the gate at every level: %s", (line) => {
    expect(shellSecurityCheck(safe, [], "/tmp/project", line, "posix")).toMatchObject({
      forcesGate: true,
      askEveryLevel: true,
      finding: { rule: "dangerous.write_startup_file" },
    });
  });

  it.each([
    "npm config get registry",
    "npm config list",
    "npm install config",
    "npm config set registry http://x --location=project",
    "yarn config get registry",
    "pip config list",
    "tar xfC x.tar /tmp/out",
    "tar czfC out.tgz ~ notes",
    "printf $'a\\tb\\n' > /tmp/project/out.txt",
    `ls ~${me}/.ssh`,
    "cp x ~root/notes.txt",
    `pwsh -c "Set-Content -Path notes.txt -Value '~/.zshrc'"`,
    'pwsh -c "Out-File -FilePath out.txt -Encoding utf8"',
  ])("is not a sensitive write: %s", (line) => {
    expect(shellSecurityCheck(safe, [], "/tmp/project", line, "posix")).toEqual({
      forcesGate: false,
      askEveryLevel: false,
    });
  });

  // Test-mutation gap: the guard's sure credential finding names an
  // unreadable line better than the generic "cannot be read" reason.
  it("keeps the guard's credential finding for an unreadable line naming an entry", () => {
    const verdict = {
      action: "approval_required",
      rule: "dangerous.read_credentials",
      reason: "reads a credential file (~/.ssh/id_rsa)",
      confidence: 0.9,
      askEveryLevel: true,
    } as GuardVerdict;
    const check = shellSecurityCheck(verdict, [], "/tmp/project", "cat ~/.ssh/id_rsa 'open", "posix");
    expect(check.finding?.rule).toBe("dangerous.read_credentials");
    expect(check.askEveryLevel).toBe(true);
  });

  // Test-mutation gap: every reader of `read-only-commands.ts`, not only
  // ls / cat / echo, keeps a glob argument from counting as a write.
  it.each([
    "cat", "bat", "less", "more", "head", "tail", "ls", "ll", "la", "exa", "eza",
    "stat", "file", "wc", "du", "df", "grep", "egrep", "fgrep", "rg", "ag", "ack",
    "diff", "cmp", "comm", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum",
    "readlink", "realpath", "basename", "dirname", "echo", "printf", "test", "true", "false",
    ":", "which", "whereis", "type", "hexdump", "od", "strings", "jq",
    "cut", "tr", "column", "nl", "fold",
    "dir", "where", "get-content", "gc", "get-childitem", "gci", "get-item", "gi",
    "test-path", "select-string", "sls", "resolve-path", "get-filehash",
  ])("a glob read by %s is not a write", (reader) => {
    expect(shellSecurityCheck(safe, [], "/tmp/project", `${reader} ~/.zsh*`, "posix").forcesGate).toBe(false);
  });
});
