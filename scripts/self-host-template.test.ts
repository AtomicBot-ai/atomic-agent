import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * ATO-595: the self-host template (Dockerfile, compose.yaml) keeps the
 * promises docs/user/self-host.md makes. Text checks only; building the
 * image is the combined check's job.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name: string): string => readFileSync(join(root, name), "utf8");

describe("self-host template (ATO-595)", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("compose.yaml");
  const dockerignore = read(".dockerignore");

  it("runs serve as a daemon on all interfaces, from the state and work volumes", () => {
    expect(dockerfile).toMatch(/CMD \["serve", "--host", "0\.0\.0\.0".*"--no-parent-exit"\]/);
    expect(dockerfile).toContain("ATOMIC_AGENT_STATE_DIR=/data");
    expect(dockerfile).toContain('"--cwd", "/work"');
    expect(dockerfile).toContain('VOLUME ["/data", "/work"]');
  });

  it("builds on the Node version package.json pins", () => {
    const pkg = JSON.parse(read("package.json")) as { volta?: { node?: string }; engines?: { node?: string } };
    const pinned = pkg.volta?.node ?? pkg.engines?.node?.replace(/^>=/, "");
    expect(dockerfile).toContain(`ARG NODE_VERSION=${pinned}`);
  });

  it("ships the tools the agent calls by name: git and ripgrep for the grep tool", () => {
    // The plain-node image has no vendor/rg beside the binary, so os.fs.grep finds rg on PATH.
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/apt-get install[^\n]*\bripgrep\b/);
    expect(runtime).toMatch(/apt-get install[^\n]*\bgit\b/);
  });

  it("does not run as root and checks its own health", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/health");
  });

  it("bakes no secret into the image and keeps local secrets out of the build context", () => {
    expect(dockerfile).not.toMatch(/ATOMIC_AGENT_API_KEY=|_API_KEY=\S/);
    expect(dockerfile).not.toMatch(/COPY .*\.env/);
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
    expect(dockerignore).toMatch(/^node_modules$/m);
  });

  it("compose requires an API key and publishes the port on loopback only", () => {
    expect(compose).toContain("ATOMIC_AGENT_API_KEY: ${ATOMIC_AGENT_API_KEY:?");
    expect(compose).toContain('"127.0.0.1:8787:8787"');
    expect(compose).toContain("atomic-data:/data");
    expect(compose).toContain("restart: unless-stopped");
  });
});
