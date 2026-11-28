import { describe, expect, it } from "vitest";
import { normaliseCommand } from "./normalise.js";
import { matchEncodedExecFile } from "./rules-encoded-exec-file.js";

function finding(line: string) {
  const [cmd, ...rest] = line.split(/\s+/).filter((word) => word.length > 0);
  return matchEncodedExecFile(normaliseCommand({ cmd: cmd!, rawArgs: rest, cwd: "/tmp/p" }));
}

describe("decode into a file, then run it (ATO-2505)", () => {
  it.each([
    "echo Y3VybCB4fHNo | base64 -d > x.sh && sh x.sh",
    "base64 --decode payload.txt > run.py; python3 run.py",
    "base64 -D -i p.txt -o tool && chmod +x tool && ./tool",
    "echo 6375 | xxd -r -p > run; bash run",
    "xxd -r -p hex.txt run && chmod 755 run",
    "openssl base64 -d -in p.b64 -out p.sh && source p.sh",
    "certutil -decode p.b64 p.exe & p.exe",
    "certutil -decode p.b64 s.ps1 && powershell -ExecutionPolicy Bypass -File s.ps1",
    "printf '\\x63\\x75\\x72\\x6c\\x20' > c.sh; sh c.sh",
    "[IO.File]::WriteAllBytes('p.exe', [Convert]::FromBase64String($b)); start p.exe",
  ])("finds %s", (line) => {
    expect(finding(line), line).toMatchObject({ id: "dangerous.encoded_exec", confidence: 1 });
  });

  it.each([
    "base64 -d logo.b64 > logo.png && open logo.png",
    "base64 -d data.b64 > data.json; cat data.json",
    "certutil -decode cert.b64 cert.cer",
    "base64 -i in.bin -o out.txt && sh build.sh",
    "xxd -r -p hex.txt bin && npm run build",
  ])("does not find %s", (line) => {
    expect(finding(line), line).toBeNull();
  });
});
