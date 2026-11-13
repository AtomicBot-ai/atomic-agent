// ATO-556: atomicagent:// links. main/deeplink.ts is checked against the
// built output (npm run build first); the pure half of renderer/deeplink.js
// is loaded as a CommonJS module, like handoff.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/deeplink.js");
const R = require("../renderer/deeplink.js");

const mcp = (q) => M.routeDeeplink(`atomicagent://mcp/install?${q}`);
const err = (r) => (r.ok ? `accepted: ${JSON.stringify(r.request)}` : r.error);

/* ---------------- parser ---------------- */

test("parse: host, path and repeated params, in order", () => {
  const r = M.parseDeeplink("atomicagent://mcp/install?name=files&arg=-y&arg=pkg");
  assert.equal(r.ok, true);
  assert.equal(r.link.host, "mcp");
  assert.deepEqual(r.link.path, ["install"]);
  assert.deepEqual(r.link.params.get("arg"), ["-y", "pkg"]);
  assert.deepEqual(r.link.params.get("name"), ["files"]);
});

test("parse: a trailing slash and upper case scheme / host read the same", () => {
  const r = M.parseDeeplink("AtomicAgent://MCP/Install/?name=x");
  assert.equal(r.ok, true);
  assert.equal(r.link.host, "mcp");
  assert.deepEqual(r.link.path, ["install"]);
});

test("parse: anything off-shape is refused", () => {
  const bad = [
    42,
    "",
    "https://atomicagent.io/mcp/install",
    "atomicagent:mcp/install",
    "atomicagent://user:pw@mcp/install",
    "atomicagent://mcp:8080/install",
    "atomicagent://mcp/install#frag",
    "atomicagent://mcp/install?name=a\nb",
    "atomicagent://mcp/install?name=a%0Ab",
    "atomicagent://m_cp/install",
    "atomicagent://mcp/a/b/c/d/e",
    "atomicagent://mcp/inst%61ll",
    "atomicagent://mcp/install?Name-X=1",
    `atomicagent://mcp/install?name=${"a".repeat(M.DEEPLINK_MAX_VALUE + 1)}`,
    `atomicagent://mcp/install?${Array.from({ length: M.DEEPLINK_MAX_PARAMS + 1 }, (_, i) => `k${i}=1`).join("&")}`,
    `atomicagent://mcp/install?name=${"a".repeat(M.DEEPLINK_MAX_LENGTH)}`,
  ];
  for (const raw of bad) assert.equal(M.parseDeeplink(raw).ok, false, String(raw).slice(0, 80));
});

/* ---------------- router ---------------- */

test("router: an unknown host is an error; a new route adds itself with one line", () => {
  const before = M.routeDeeplink("atomicagent://recipe?x=1");
  assert.equal(before.ok, false);
  assert.match(before.error, /does not know the "recipe" link/);
  M.registerDeeplinkRoute("recipe", (link) => ({ ok: true, request: { route: "recipe", link: link.raw, x: link.params.get("x") } }));
  const after = M.routeDeeplink("atomicagent://recipe?x=1");
  assert.equal(after.ok, true);
  assert.deepEqual(after.request.x, ["1"]);
  assert.deepEqual(M.deeplinkHosts().includes("mcp") && M.deeplinkHosts().includes("skill"), true);
  assert.throws(() => M.registerDeeplinkRoute("Bad Host", () => ({ ok: false, error: "" })));
});

test("router: a route that throws becomes an error, not a crash", () => {
  M.registerDeeplinkRoute("boom", () => { throw new Error("kaput"); });
  const r = M.routeDeeplink("atomicagent://boom");
  assert.equal(r.ok, false);
  assert.match(r.error, /kaput/);
});

test("takeParams: unknown keys, repeats and required keys", () => {
  const link = M.parseDeeplink("atomicagent://x/y?a=1&a=2&b=").link;
  assert.equal(M.takeParams(link, { a: { max: 2 } }).ok, false);   // b unknown
  assert.equal(M.takeParams(link, { a: { max: 1 }, b: { max: 1 } }).ok, false);   // a twice
  assert.equal(M.takeParams(link, { a: { max: 2 }, b: { max: 1, required: true } }).ok, false);   // b empty
  const ok = M.takeParams(link, { a: { max: 2 }, b: { max: 1 }, c: { max: 1 } });
  assert.deepEqual(ok, { ok: true, values: { a: ["1", "2"], b: [""], c: [] } });
});

/* ---------------- mcp/install: stdio ---------------- */

test("mcp: an npx server becomes the mcp.servers entry Settings writes", () => {
  const r = mcp("name=files&description=Local%20files&command=npx&arg=-y&arg=%40scope%2Fserver-files%401.2.0&arg=%2Ftmp%2Fmy%20docs&env=ROOT%3D%2Ftmp");
  assert.equal(r.ok, true, err(r));
  assert.equal(r.request.route, "mcp-install");
  assert.deepEqual(r.request.server, {
    name: "files",
    description: "Local files",
    transport: { kind: "stdio", command: "npx", args: ["-y", "@scope/server-files@1.2.0", "/tmp/my docs"] },
    env: { ROOT: "/tmp" },
  });
  assert.match(r.request.warnings[0], /runs npx on this computer/);
  assert.equal(r.request.warnings.some((w) => /no version/.test(w)), false);
  assert.match(r.request.link, /^atomicagent:\/\/mcp\/install\?/);
});

test("mcp: args= is the same as arg=, and an unpinned package is warned about", () => {
  const r = mcp("name=gh&command=npx&args=-y&args=%40modelcontextprotocol%2Fserver-github&env=GITHUB_TOKEN");
  assert.equal(r.ok, true, err(r));
  assert.deepEqual(r.request.server.transport.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(r.request.server.env, { GITHUB_TOKEN: "" });
  assert.ok(r.request.warnings.some((w) => /has no version/.test(w)));
  assert.ok(r.request.warnings.some((w) => /Empty settings \(GITHUB_TOKEN\)/.test(w)));
});

test("mcp: uvx and bunx are allowed, with their package checks", () => {
  assert.equal(mcp("name=time&command=uvx&arg=mcp-server-time%3D%3D0.6.2").ok, true);
  assert.ok(mcp("name=time&command=uvx&arg=mcp-server-time").request.warnings.some((w) => /no version/.test(w)));
  assert.equal(mcp("name=b&command=bunx&arg=some-mcp%401.0.0").ok, true);
  assert.equal(mcp("name=time&command=uvx").ok, false);
  assert.equal(mcp("name=time&command=npx&arg=-y").ok, false);
});

test("mcp: only the allowlisted runners, by bare name", () => {
  for (const cmd of ["bash", "sh", "node", "python3", "cmd", "powershell", "/usr/bin/npx", "npx.cmd", "C:\\npx.exe", "./npx", "curl"]) {
    const r = mcp(`name=x1&command=${encodeURIComponent(cmd)}&arg=y`);
    assert.equal(r.ok, false, cmd);
    assert.match(r.error, /may only start npx, uvx, bunx, docker/);
  }
  assert.deepEqual(M.MCP_COMMAND_ALLOWLIST, ["npx", "uvx", "bunx", "docker"]);
});

test("mcp: flags that make a runner a shell or switch its registry are refused", () => {
  const cases = [
    ["npx", ["-c", "rm -rf ~"]],
    ["npx", ["--call=whoami"]],
    ["npx", ["--node-options=--require=/tmp/x", "pkg@1"]],
    ["npx", ["--registry", "https://evil.example", "pkg@1"]],
    ["uvx", ["--index-url", "https://evil.example", "pkg==1"]],
    ["uvx", ["-i", "https://evil.example", "pkg==1"]],
    ["bunx", ["--registry=https://evil.example", "pkg@1"]],
  ];
  for (const [cmd, args] of cases) assert.equal(M.checkMcpCommand(cmd, args).ok, false, `${cmd} ${args.join(" ")}`);
});

test("mcp: cmd.exe's special characters and line breaks never pass", () => {
  for (const a of ["pkg&calc", "a|b", "a>b", "a<b", "a^b", 'a"b', "%PATH%", "a`b", "a\nb", "a\rb"]) {
    assert.equal(M.checkMcpCommand("npx", ["-y", a]).ok, false, JSON.stringify(a));
  }
  assert.equal(M.checkMcpCommand("npx", ["-y", "pkg@1", "/Users/me/My Documents"]).ok, true);
});

test("mcp: a package on this computer is not a published package", () => {
  for (const p of ["./evil", "../evil", "/tmp/evil", "~/Downloads/evil", "file:../x", "C:\\Users\\x", "c:/x", "\\\\server\\share"]) {
    assert.equal(M.checkMcpCommand("npx", ["-y", p]).ok, false, p);
    assert.equal(M.localPackageSpec(p), true, p);
  }
  assert.equal(M.localPackageSpec("@scope/pkg@1.0.0"), false);
  assert.equal(M.localPackageSpec("github:owner/repo"), false);
  assert.equal(M.checkMcpCommand("uvx", ["--from", "./local", "tool"]).ok, false);
});

test("mcp: too many or too long arguments", () => {
  assert.equal(M.checkMcpCommand("npx", Array.from({ length: M.MCP_MAX_ARGS + 1 }, () => "a")).ok, false);
  assert.equal(M.checkMcpCommand("npx", ["-y", "a".repeat(1025)]).ok, false);
  assert.equal(M.checkMcpCommand("npx", [7]).ok, false);
  assert.equal(M.checkMcpCommand(undefined, []).ok, false);
});

test("mcp: environment names that change what runs are refused, any case", () => {
  for (const k of ["PATH", "Path", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "npm_config_registry", "NPM_CONFIG_USERCONFIG", "PIP_INDEX_URL", "UV_INDEX_URL", "PYTHONPATH", "DOCKER_HOST", "HTTPS_PROXY", "ComSpec"]) {
    const r = mcp(`name=x1&command=npx&arg=pkg%401&env=${encodeURIComponent(k + "=x")}`);
    assert.equal(r.ok, false, k);
    assert.equal(M.envNameBlocked(k), true, k);
  }
  assert.equal(M.envNameBlocked("GITHUB_TOKEN"), false);
  assert.equal(mcp("name=x1&command=npx&arg=pkg%401&env=1BAD%3Dx").ok, false);
  assert.equal(mcp("name=x1&command=npx&arg=pkg%401&env=A%3D1&env=A%3D2").ok, false);
  assert.equal(mcp(`name=x1&command=npx&arg=pkg%401&${Array.from({ length: M.MCP_MAX_ENV + 1 }, (_, i) => `env=K${i}%3D1`).join("&")}`).ok, false);
});

test("mcp: docker run only, without the host's powers", () => {
  const ok = M.checkMcpCommand("docker", ["run", "-i", "--rm", "-e", "TOKEN", "-v", "/Users/me/notes:/data", "mcp/notes:1.4"]);
  assert.equal(ok.ok, true, err({ ok: false, error: ok.error }));
  assert.ok(ok.warnings.some((w) => /read and write \/Users\/me\/notes/.test(w)));
  assert.equal(ok.warnings.some((w) => /no fixed version/.test(w)), false);
  assert.ok(M.checkMcpCommand("docker", ["run", "-i", "--rm", "mcp/notes"]).warnings.some((w) => /no fixed version/.test(w)));
  assert.ok(M.checkMcpCommand("docker", ["run", "-i", "mcp/notes:latest"]).warnings.some((w) => /no fixed version/.test(w)));
  assert.equal(M.checkMcpCommand("docker", ["run", "-i", "localhost:5000/notes@sha256:abc"]).warnings.some((w) => /no fixed version/.test(w)), false);
  const refused = [
    ["exec", "box", "sh"],
    ["run", "--privileged", "img:1"],
    ["run", "--pid=host", "img:1"],
    ["run", "--cap-add", "SYS_ADMIN", "img:1"],
    ["run", "--network", "host", "img:1"],
    ["run", "--net=host", "img:1"],
    ["run", "-v", "/:/host", "img:1"],
    ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img:1"],
    ["run", "--mount", "type=bind,source=/,target=/host", "img:1"],
    ["run", "-i", "--rm"],
  ];
  for (const args of refused) assert.equal(M.checkMcpCommand("docker", args).ok, false, args.join(" "));
});

test("mcp: the docker mount guard reads every spelling of a mount (review F08-8)", () => {
  const refused = [
    ["run", "-v/:/host", "alpine:3.20"],
    ["run", "-v=/:/host", "alpine:3.20"],
    ["run", "-itv/:/host", "alpine:3.20"],
    ["run", "-it", "-v", "/:/host:ro", "alpine:3.20"],
    ["run", "--volume=/:/host", "alpine:3.20"],
    ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock:ro", "img:1"],
    ["run", "-v", "/run/user/501/docker.sock:/s", "img:1"],
    ["run", "-v", "/Users/me/.docker/run/docker.sock:/s:ro", "img:1"],
    ["run", "--mount", "type=bind,src=//,dst=/host", "img:1"],
    ["run", "--mount", "type=bind,source=/./,target=/host,readonly", "img:1"],
    ["run", "--mount=type=bind,src=/var/run/docker.sock,dst=/s,ro", "img:1"],
    ["run", "-v", "//:/host", "img:1"],
    ["run", "-v", "/./:/host", "img:1"],
    ["run", "-v", "/etc/..:/host", "img:1"],
    ["run", "-v", "/var/run:/r", "img:1"],
    ["run", "img:1", "-v", "/:/host"],   // after the image too: an unknown value flag could hide the image
  ];
  for (const args of refused) assert.equal(M.checkMcpCommand("docker", args).ok, false, args.join(" "));
  assert.match(M.checkMcpCommand("docker", ["run", "-v/:/host", "alpine:3.20"]).error, /whole disk or the Docker socket/);
});

test("mcp: Windows drive roots and the Docker pipe are refused as mounts (review F08-8)", () => {
  const refused = [
    ["run", "-v", "C:\\:/host", "img:1"],
    ["run", "-v", "C:/:/host", "img:1"],
    ["run", "-v", "c:\\.\\:/host:ro", "img:1"],
    ["run", "-v", "D::/host", "img:1"],
    ["run", "-v", "/c/:/host", "img:1"],
    ["run", "-v", "/mnt/c:/host", "img:1"],
    ["run", "-v", "/host_mnt/c/:/host", "img:1"],
    ["run", "--mount", "type=bind,source=C:\\,target=/host", "img:1"],
    ["run", "-v", "//./pipe/docker_engine://./pipe/docker_engine", "img:1"],
    ["run", "-v", "\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine", "img:1"],
  ];
  for (const args of refused) assert.equal(M.checkMcpCommand("docker", args).ok, false, args.join(" "));
  const folder = M.checkMcpCommand("docker", ["run", "-v", "C:\\Users\\me\\notes:/data:ro", "img:1"]);
  assert.equal(folder.ok, true, err({ ok: false, error: folder.error }));
  assert.ok(folder.warnings.some((w) => w === "The container can read C:\\Users\\me\\notes on this computer."));
  const vol = M.checkMcpCommand("docker", ["run", "-v", "cache:/cache", "img:1"]);
  assert.equal(vol.ok, true);
  assert.ok(vol.warnings.some((w) => /Docker volume named cache/.test(w)));
});

test("normaliseHostPath / dockerFlags: one spelling for every path and flag", () => {
  for (const p of ["/", "//", "/./", "/.", "///", "/a/..", "\\"]) assert.equal(M.normaliseHostPath(p), "/", p);
  for (const p of ["C:\\", "C:/", "c:", "C:\\.", "/c", "/c/", "/mnt/C", "/host_mnt/c"]) assert.equal(M.normaliseHostPath(p), "c:", p);
  assert.equal(M.normaliseHostPath("/Users//me/./notes/"), "/Users/me/notes");
  assert.deepEqual(M.dockerFlags(["-itv/:/h", "-e", "A", "--mount=src=/x", "--rm"]), [
    { name: "-i", value: "" }, { name: "-t", value: "" }, { name: "-v", value: "/:/h" },
    { name: "-e", value: "A" }, { name: "--mount", value: "src=/x" }, { name: "--rm", value: "" },
  ]);
  assert.deepEqual(M.dockerFlags(["-v=/a:/b"]), [{ name: "-v", value: "/a:/b" }]);
  assert.equal(M.volumeSource("/a:/b:ro"), "/a");
  assert.equal(M.volumeSource("C:\\x:/b"), "C:\\x");
  assert.equal(M.volumeSource("/anon"), "");
  assert.equal(M.mountSource("type=bind,src=//,dst=/h"), "//");
  assert.equal(M.dockerSourceRefused("data"), false);
});

test("mcp: npx and bunx take only -y, --yes and -p/--package before the package (review F08-9)", () => {
  assert.equal(M.checkMcpCommand("npx", ["-yc", "echo hi; id"]).ok, false);
  assert.equal(M.checkMcpCommand("npx", ["--regi=https://e.x", "a@1"]).ok, false);
  const refused = [
    ["-cy", "id"], ["-yp", "a@1"], ["--yes=true", "a@1"], ["--call", "id"], ["--reg", "https://e.x", "a@1"],
    ["--userconf=/tmp/x", "a@1"], ["--", "a@1"], ["-y", "--no-install", "a@1"], ["--package"], ["-p", "--registry=x", "a@1"],
    ["-p", "a@1", "echo hi; id"], ["-p", "a@1", "$(id)"], ["--package=a@1", "sh -c id"],
  ];
  for (const args of refused) {
    assert.equal(M.checkMcpCommand("npx", args).ok, false, "npx " + args.join(" "));
    assert.equal(M.checkMcpCommand("bunx", args).ok, false, "bunx " + args.join(" "));
  }
  assert.equal(M.checkMcpCommand("bunx", ["--bun", "a@1"]).ok, false);
  for (const args of [["-y", "a@1"], ["--yes", "@s/a@1.2.0", "--port", "3", "-v"], ["-p", "a@1", "a-bin"], ["--package=a@1", "a-bin", "--stdio"], ["--package", "@s/a@1", "@s/a"]]) {
    const r = M.checkMcpCommand("npx", args);
    assert.equal(r.ok, true, "npx " + args.join(" ") + ": " + (r.ok ? "" : r.error));
  }
  assert.equal(M.checkMcpCommand("npx", ["-p", "./evil", "bin"]).ok, false);
  assert.ok(M.checkMcpCommand("npx", ["-p", "a", "bin"]).warnings.some((w) => /has no version/.test(w)));
});

test("mcp: uvx takes only --from, --with, --python and -q before the package", () => {
  const refused = [
    ["--index", "https://e.x", "p==1"], ["--index-url=https://e.x", "p==1"], ["--extra-index-url", "https://e.x", "p==1"],
    ["--default-index", "https://e.x", "p==1"], ["--find-links", "/tmp", "p==1"], ["-i", "https://e.x", "p==1"], ["-f", "/tmp", "p==1"],
    ["--with-requirements", "r.txt", "p==1"], ["--with-editable", ".", "p==1"], ["--config-file", "/tmp/uv.toml", "p==1"],
    ["-qi", "https://e.x", "p==1"], ["--python", "/tmp/evil/python", "p==1"], ["--from", "p==1"], ["--with", "./x", "p==1"],
    ["--from", "p==1", "echo hi; id"],
  ];
  for (const args of refused) assert.equal(M.checkMcpCommand("uvx", args).ok, false, "uvx " + args.join(" "));
  for (const args of [["--from", "git+https://github.com/o/r@v1", "tool"], ["--from=p==1", "p"], ["--python", "3.12", "p==1"], ["-q", "--with", "extra==2", "p==1", "--index", "x"]]) {
    const r = M.checkMcpCommand("uvx", args);
    assert.equal(r.ok, true, "uvx " + args.join(" ") + ": " + (r.ok ? "" : r.error));
  }
});

test("dockerImage: skips flags and their values", () => {
  assert.equal(M.dockerImage(["run", "-i", "--rm", "-e", "A=1", "--name", "x", "-v", "/a:/b", "img:2", "serve"]), "img:2");
  assert.equal(M.dockerImage(["run", "--env=A=1", "img:2"]), "img:2");
  assert.equal(M.dockerImage(["run", "-i"]), null);
});

/* ---------------- mcp/install: remote ---------------- */

test("mcp: a remote server by https address", () => {
  const r = mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fmcp");
  assert.equal(r.ok, true, err(r));
  assert.deepEqual(r.request.server, { name: "docs", transport: { kind: "streamable_http", url: "https://example.com/mcp" } });
  assert.match(r.request.warnings[0], /goes through example\.com/);
  assert.equal(mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fsse").request.server.transport.kind, "sse");
  assert.equal(mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fx&transport=sse").request.server.transport.kind, "sse");
  assert.equal(mcp("name=docs&url=http%3A%2F%2F127.0.0.1%3A3000%2Fmcp").ok, true);
});

test("mcp: remote addresses that are refused", () => {
  for (const u of ["http://example.com/mcp", "ftp://example.com/x", "https://user:pw@example.com/mcp", "javascript:alert(1)", "not a url"]) {
    assert.equal(mcp(`name=docs&url=${encodeURIComponent(u)}`).ok, false, u);
  }
  assert.equal(mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fmcp&arg=x").ok, false);
  assert.equal(mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fmcp&transport=ws").ok, false);
  assert.equal(mcp("name=docs&command=npx&arg=p%401&transport=sse").ok, false);
});

test("mcp: the link's own shape", () => {
  assert.equal(mcp("command=npx&arg=p%401").ok, false);   // no name
  assert.equal(mcp("name=Files&command=npx&arg=p%401").ok, false);   // the agent's name rule
  assert.equal(mcp("name=a&command=npx&arg=p%401").ok, false);   // too short
  assert.equal(mcp("name=files").ok, false);   // neither command nor url
  assert.equal(mcp("name=files&command=npx&arg=p%401&url=https%3A%2F%2Fx.io").ok, false);   // both
  assert.equal(mcp("name=files&command=npx&arg=p%401&trust=pure_read").ok, false);   // a link cannot set trust
  assert.equal(mcp(`name=files&command=npx&arg=p%401&description=${"d".repeat(201)}`).ok, false);
  assert.equal(M.routeDeeplink("atomicagent://mcp/remove?name=files").ok, false);
  assert.equal(M.routeDeeplink("atomicagent://mcp?name=files&command=npx").ok, false);
});

/* ---------------- skill/install ---------------- */

test("skill: @owner/slug, owner/slug and owner= give the install identifier", () => {
  for (const q of ["slug=%40alice%2Fpdf-tools", "slug=alice%2Fpdf-tools", "slug=pdf-tools&owner=alice", "slug=pdf-tools&owner=%40alice"]) {
    const r = M.routeDeeplink(`atomicagent://skill/install?${q}`);
    assert.equal(r.ok, true, `${q}: ${err(r)}`);
    assert.equal(r.request.route, "skill-install");
    assert.equal(r.request.identifier, "@alice/pdf-tools");
    assert.equal(r.request.slug, "pdf-tools");
    assert.equal(r.request.owner, "alice");
    assert.match(r.request.warnings[0], /security scan/);
  }
});

test("skill: a bare slug asks ClawHub for its owner (no identifier yet)", () => {
  const r = M.routeDeeplink("atomicagent://skill/install?slug=pdf-tools");
  assert.equal(r.ok, true);
  assert.equal(r.request.identifier, null);
  assert.equal(r.request.owner, null);
});

test("skill: refused shapes", () => {
  for (const q of ["", "slug=", "slug=%40alice%2Fpdf&owner=bob", "slug=..%2F..%2Fetc", "slug=a%2Fb%2Fc", "slug=-x", "slug=x&owner=-bad", "slug=x&extra=1", "slug=x&slug=y"]) {
    assert.equal(M.routeDeeplink(`atomicagent://skill/install?${q}`).ok, false, q);
  }
  assert.equal(M.routeDeeplink("atomicagent://skill/remove?slug=x").ok, false);
});

/* ---------------- the OS side ---------------- */

test("shouldRegisterProtocol: only a packaged, ordinary launch", () => {
  const base = { packaged: true, argv: ["/Applications/Atomic Agent.app/Contents/MacOS/Atomic Agent"], env: {}, stateDirFromEnv: false };
  assert.equal(M.shouldRegisterProtocol(base), true);
  assert.equal(M.shouldRegisterProtocol({ ...base, packaged: false }), false);
  assert.equal(M.shouldRegisterProtocol({ ...base, stateDirFromEnv: true }), false);
  for (const flag of ["--smoke", "--smoke-task=04", "--smoke-fusion", "--first-run-probe", "--models", "--dev", "--remote-debugging-port=9222", "--fake-ram=8", "--fake-update=9.9.9"]) {
    assert.equal(M.shouldRegisterProtocol({ ...base, argv: [...base.argv, flag] }), false, flag);
  }
  for (const env of [{ VITEST: "1" }, { NODE_ENV: "test" }, { NODE_ENV: "development" }, { ATOMIC_AGENT_NO_DEEPLINKS: "1" }, { ATOMIC_AGENT_NO_DEEPLINKS: "true" }]) {
    assert.equal(M.shouldRegisterProtocol({ ...base, env }), false, JSON.stringify(env));
  }
  assert.equal(M.shouldRegisterProtocol({ ...base, env: { ATOMIC_AGENT_NO_DEEPLINKS: "0" } }), true);
  // A link in argv (Windows / Linux) is not a test flag.
  assert.equal(M.shouldRegisterProtocol({ ...base, argv: [...base.argv, "atomicagent://skill/install?slug=a/b"] }), true);
});

test("deeplinkFromArgv: the first atomicagent: argument", () => {
  assert.equal(M.deeplinkFromArgv(["app.exe", "--flag", "AtomicAgent://skill/install?slug=a/b"]), "AtomicAgent://skill/install?slug=a/b");
  assert.equal(M.deeplinkFromArgv(["app.exe", "--flag"]), null);
});

function fakeApp({ lock = true } = {}) {
  const calls = { protocol: [], exit: [], openUrl: null, second: null, lock: 0 };
  return {
    calls,
    app: {
      setAsDefaultProtocolClient: (p) => { calls.protocol.push(p); return true; },
      requestSingleInstanceLock: () => { calls.lock += 1; return lock; },
      exit: (code) => { calls.exit.push(code); },
      onOpenUrl: (fn) => { calls.openUrl = fn; },
      onSecondInstance: (fn) => { calls.second = fn; },
    },
  };
}

function deps(over = {}) {
  const seen = { shown: 0, notified: 0, logs: [] };
  let t = 1000;
  return {
    seen,
    tick: (ms) => { t += ms; },
    d: {
      enabled: true, argv: ["app"], ready: () => true,
      showWindow: () => { seen.shown += 1; }, notify: () => { seen.notified += 1; },
      log: (l) => seen.logs.push(l), now: () => t,
      ...over,
    },
  };
}

test("wireDeeplinks: a disabled run registers nothing and takes no lock", () => {
  const { app, calls } = fakeApp();
  const { d } = deps({ enabled: false, argv: ["app", "atomicagent://skill/install?slug=a/b"] });
  const q = M.wireDeeplinks(app, d);
  assert.deepEqual(calls.protocol, []);
  assert.equal(calls.lock, 0);
  assert.equal(calls.openUrl, null);
  assert.deepEqual(q.take(), []);
  // --deeplink-test feeds it by hand.
  q.handle("atomicagent://skill/install?slug=a/b");
  assert.equal(q.take()[0].route, "skill-install");
});

test("wireDeeplinks: the first launch registers, takes its argv link, and listens", () => {
  const { app, calls } = fakeApp();
  const { d, seen } = deps({ ready: () => false, argv: ["app", "atomicagent://skill/install?slug=a/b"] });
  const q = M.wireDeeplinks(app, d);
  assert.deepEqual(calls.protocol, ["atomicagent"]);
  assert.equal(calls.lock, 1);
  assert.deepEqual(calls.exit, []);
  assert.equal(typeof calls.openUrl, "function");
  assert.equal(typeof calls.second, "function");
  assert.equal(seen.shown, 0);   // not ready: it waits for the window
  const taken = q.take();
  assert.equal(taken.length, 1);
  assert.equal(taken[0].identifier, "@a/b");
  assert.deepEqual(q.take(), []);
  assert.ok(seen.logs.every((l) => !l.includes("slug")));   // the log names the route only
});

test("wireDeeplinks: a second launch with a link hands it over and exits", () => {
  const { app, calls } = fakeApp({ lock: false });
  const { d } = deps({ argv: ["app", "atomicagent://skill/install?slug=a/b"] });
  M.wireDeeplinks(app, d);
  assert.deepEqual(calls.exit, [0]);
  assert.equal(calls.openUrl, null);
});

test("wireDeeplinks: a second launch without a link carries on as before", () => {
  const { app, calls } = fakeApp({ lock: false });
  M.wireDeeplinks(app, deps().d);
  assert.deepEqual(calls.exit, []);
  assert.equal(typeof calls.openUrl, "function");
});

test("wireDeeplinks: open-url and second-instance reach the window; a double click counts once", () => {
  const { app, calls } = fakeApp();
  const { d, seen, tick } = deps();
  const q = M.wireDeeplinks(app, d);
  calls.openUrl("atomicagent://mcp/install?name=docs&url=https%3A%2F%2Fexample.com%2Fmcp");
  calls.openUrl("atomicagent://mcp/install?name=docs&url=https%3A%2F%2Fexample.com%2Fmcp");
  assert.equal(seen.shown, 1);
  assert.equal(seen.notified, 1);
  tick(2500);
  calls.openUrl("atomicagent://mcp/install?name=docs&url=https%3A%2F%2Fexample.com%2Fmcp");
  calls.second(["app.exe", "--x"]);   // no link: nothing
  calls.second(["app.exe", "atomicagent://nope"]);
  const taken = q.take();
  assert.deepEqual(taken.map((r) => r.route), ["mcp-install", "mcp-install", "error"]);
  assert.match(taken[2].error, /does not know the "nope" link/);
});

test("wireDeeplinks: the queue keeps the newest five", () => {
  const { app } = fakeApp();
  const { d } = deps();
  const q = M.wireDeeplinks(app, d);
  for (let i = 0; i < 8; i++) q.handle(`atomicagent://skill/install?slug=a/s${i}`);
  assert.deepEqual(q.take().map((r) => r.slug), ["s3", "s4", "s5", "s6", "s7"]);
});

/* ---------------- the card (renderer/deeplink.js, pure half) ---------------- */

test("card: the exact command line, quoted where it has spaces", () => {
  assert.equal(R.deeplinkCommandLine("npx", ["-y", "@scope/pkg@1", "/tmp/my docs", "it's"]), "npx -y @scope/pkg@1 '/tmp/my docs' 'it'\\''s'");
  assert.equal(R.deeplinkCommandLine("uvx", undefined), "uvx");
});

test("card: every row of the server, settings with their values", () => {
  const r = mcp("name=files&description=Local&command=npx&arg=-y&arg=pkg%401&env=ROOT%3D%2Ftmp").request;
  assert.deepEqual(R.deeplinkMcpRows(r.server), [["name", "files"], ["runs", "npx -y pkg@1"], ["setting", "ROOT=/tmp"], ["about", "Local"]]);
  const remote = mcp("name=docs&url=https%3A%2F%2Fexample.com%2Fsse").request;
  assert.deepEqual(R.deeplinkMcpRows(remote.server), [["name", "docs"], ["address", "https://example.com/sse"], ["type", "remote server (SSE)"]]);
  assert.deepEqual(R.deeplinkMcpRows(null), []);
});

test("card: the skill identifier, from the link or from ClawHub's owner", () => {
  assert.equal(R.deeplinkSkillIdentifier({ identifier: "@a/b", slug: "b" }, null), "@a/b");
  assert.equal(R.deeplinkSkillIdentifier({ identifier: null, slug: "b" }, { ownerHandle: "carol" }), "@carol/b");
  assert.equal(R.deeplinkSkillIdentifier({ identifier: null, slug: "b" }, { ownerHandle: "--x" }), null);
  assert.equal(R.deeplinkSkillIdentifier({ identifier: null, slug: "b" }, null), null);
});

test("card: titles", () => {
  assert.equal(R.deeplinkTitle({ route: "mcp-install" }), "Add this MCP server?");
  assert.equal(R.deeplinkTitle({ route: "skill-install" }), "Install this skill?");
  assert.equal(R.deeplinkTitle({ route: "error" }), "This link can\u2019t be opened");
});

/* ---------------- the card on screen (renderer/deeplink.js in a vm, review F08-7) ---------------- */

const DLINK_SRC = readFileSync(new URL("../renderer/deeplink.js", import.meta.url), "utf8");
const RENDERER_SRC = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const mcpReq = (name) => ({
  route: "mcp-install", link: `atomicagent://mcp/install?name=${name}`, warnings: [],
  server: { name, transport: { kind: "stdio", command: "npx", args: [`${name}@1`] } },
});

/** deeplink.js with renderer.js's globals stubbed; render() draws the overlay as overlaysHTML does. */
function cardPage() {
  const page = { pending: [], added: [], toasts: [] };
  const ctx = vm.createContext({
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout,
    S: { overlay: null, settings: null }, MCP: {},
    BR: { deeplinkTake: async () => page.pending.splice(0), onDeeplink() {} },
    toast: (title) => page.toasts.push(title),
    mcpAddSubmit: async (json) => { page.added.push(JSON.parse(json).name); return { ok: true }; },
    sheet: (title, body, foot) => title + body + foot, ic: () => "", esc: (v) => String(v),
  });
  vm.runInContext(DLINK_SRC + `
    function render() { globalThis.html = S.overlay === 'deeplink' ? deeplinkSheetHTML() : (deeplinkWhenClosed(), ''); }
    globalThis.DL = DLINK;`, ctx);
  page.ctx = ctx;
  page.link = async (name) => { page.pending.push(mcpReq(name)); await ctx.deeplinkPull(); };
  page.install = () => ctx.deeplinkAct("install");   // act('dlink:install') in renderer.js
  page.settle = () => { ctx.DL.armAt = 0; };          // the card has been on screen past the arming delay
  return page;
}

test("card race: a link that comes in while a card is open waits; Install in the same tick installs A, never B", async () => {
  const p = cardPage();
  await p.link("a");
  p.settle();
  await p.link("b");                       // B arrives while A is on screen
  p.install();                             // same tick: the click meant for A
  await tick();
  assert.deepEqual(p.added, ["a"], "no mcpAddSubmit call for b");
  assert.ok(p.toasts.includes("Another link is waiting"));
  await tick();                            // A's card closed on success: B opens now
  assert.equal(p.ctx.S.overlay, "deeplink");
  assert.equal(p.ctx.DL.req.server.name, "b");
  p.install();                             // a click right after B appeared does nothing
  await tick();
  assert.deepEqual(p.added, ["a"]);
  assert.match(p.ctx.html, /data-act="dlink:install" disabled/);
  p.settle();
  p.install();
  await tick();
  assert.deepEqual(p.added, ["a", "b"]);
});

test("card race: Cancel on A shows the waiting link; the same link twice is one card", async () => {
  const p = cardPage();
  await p.link("a");
  await p.link("b");
  assert.equal(p.ctx.DL.req.server.name, "a");
  p.ctx.S.overlay = null; p.ctx.render();  // Cancel / Escape / the scrim (act's close())
  await tick();
  assert.equal(p.ctx.DL.req.server.name, "b");
  assert.equal(p.ctx.S.overlay, "deeplink");
  await p.link("b");                       // the same link twice is one card
  assert.equal(p.ctx.DL.queue.length, 0);
});

test("card: Install is off for a moment after the card's content changes", async () => {
  const p = cardPage();
  await p.link("a");
  assert.match(p.ctx.html, /data-act="dlink:install" disabled/);
  p.install();
  await tick();
  assert.deepEqual(p.added, []);
  p.settle(); p.ctx.render();
  assert.doesNotMatch(p.ctx.html, /data-act="dlink:install" disabled/);
  p.ctx.deeplinkArm(); p.ctx.render();     // e.g. ClawHub's details or "Install anyway" just arrived
  assert.match(p.ctx.html, /data-act="dlink:install" disabled/);
  assert.ok(/const DLINK_ARM_MS = 1000;/.test(DLINK_SRC));
});

test("renderer.js: the overlay hook opens a waiting link once the card is closed", () => {
  assert.match(RENDERER_SRC, /if \(S\.overlay === 'deeplink'\) html \+= deeplinkSheetHTML\(\); else deeplinkWhenClosed\(\);/);
});
