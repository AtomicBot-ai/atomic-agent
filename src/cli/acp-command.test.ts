import { Console } from "node:console";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SessionState } from "../session/index.js";
import { acpCommand, claimStdout } from "./acp-command.js";
import type { AcpRuntime } from "./acp-server.js";

/** A stream that keeps everything written to it. */
class Sink extends Writable {
  private readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
  text(): string {
    return this.chunks.join("");
  }
  lines(): string[] {
    return this.text()
      .split("\n")
      .filter((line) => line.length > 0);
  }
}

const stubRuntime: AcpRuntime = {
  approvals: {
    canGrantAlways: () => false,
    resolve: () => false,
    denyPendingForSession: () => 0,
  },
  sessionStore: { load: () => null },
  createSession: () => ({ id: "s-1" }) as SessionState,
  runTurn: async (session) => ({ session, reason: "reply" as const }),
  shutdown: async () => undefined,
};

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("claimStdout", () => {
  it("keeps the real writer for frames and sends later stdout writes to stderr", async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const protocolOut = claimStdout(stdout, stderr);

    stdout.write("stray\n");
    new Console({ stdout, stderr }).log("from a dependency");
    await new Promise<void>((resolve, reject) =>
      protocolOut.write('{"jsonrpc":"2.0","id":1,"result":{}}\n', (err) => (err ? reject(err) : resolve())),
    );

    expect(stdout.lines()).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    expect(stderr.text()).toContain("stray");
    expect(stderr.text()).toContain("from a dependency");
  });
});

describe("acpCommand", () => {
  it("puts only JSON-RPC frames on stdout even when the runtime prints while it starts", async () => {
    const stdin = new PassThrough();
    const stdout = new Sink();
    const stderr = new Sink();
    // `console.log` in a dependency is a Console over the process stdout;
    // this one is over the stdout the command was given.
    const dependencyConsole = new Console({ stdout, stderr });

    const exit = acpCommand([], {
      stdin,
      stdout,
      stderr,
      createRuntime: () => {
        dependencyConsole.log("banner while loading config");
        return async () => {
          dependencyConsole.log("banner while booting the runtime");
          stdout.write("raw stdout write during boot\n");
          return stubRuntime;
        };
      },
    });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } })}\n`,
    );
    await until(() => stdout.lines().length >= 2);
    stdin.end();
    expect(await exit).toBe(0);

    const frames = stdout.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const frame of frames) expect(frame.jsonrpc).toBe("2.0");
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect((frames[0]!.result as { protocolVersion: number }).protocolVersion).toBe(1);
    expect(frames[1]!.result).toEqual({ sessionId: "s-1" });

    expect(stdout.text()).not.toContain("banner");
    expect(stdout.text()).not.toContain("raw stdout write");
    expect(stderr.text()).toContain("banner while loading config");
    expect(stderr.text()).toContain("banner while booting the runtime");
    expect(stderr.text()).toContain("raw stdout write during boot");
    expect(stderr.text()).toContain("atomic-agent acp: ready");
  });

  it("prints help on stdout and rejects unknown options on stderr", async () => {
    const out = new Sink();
    const err = new Sink();
    expect(await acpCommand(["--help"], { stdout: out, stderr: err })).toBe(0);
    expect(out.text()).toContain("Usage:");
    expect(await acpCommand(["--nope"], { stdout: out, stderr: err })).toBe(2);
    expect(err.text()).toContain("unknown option: --nope");
  });
});
