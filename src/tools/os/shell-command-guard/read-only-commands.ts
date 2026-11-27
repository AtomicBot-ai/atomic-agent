/**
 * Commands that only read or print what their arguments name (review
 * round 2 of ATO-2505). Their arguments are never write targets, so a
 * glob or variable among them (`ls ~/.ssh/id_*`, `cat ~/.ssh/*.pub`,
 * `dir %USERPROFILE%\.ssh`) does not count as a write the line might
 * hide. Their redirects still do (`cat x > ~/.bashrc`). A credential read
 * is the shell guard's own finding, not this one's.
 *
 * Names are basenames, lowercased, without `.exe`. Not here: `find`
 * (`-delete`, `-exec`), `sort -o`, `uniq in out`, `tree -o`, `xxd -r`,
 * any interpreter or editor.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "cat", "bat", "less", "more", "head", "tail", "ls", "ll", "la", "exa", "eza",
  "stat", "file", "wc", "du", "df", "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "diff", "cmp", "comm", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum",
  "readlink", "realpath", "basename", "dirname", "echo", "printf", "test", "[", "true", "false",
  ":", "which", "whereis", "type", "hexdump", "od", "strings", "jq",
  "cut", "tr", "column", "nl", "fold",
  // cmd.exe and PowerShell readers.
  "dir", "where", "get-content", "gc", "get-childitem", "gci", "get-item", "gi",
  "test-path", "select-string", "sls", "resolve-path", "get-filehash",
]);
