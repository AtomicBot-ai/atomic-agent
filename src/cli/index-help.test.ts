import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_CONFIG_DEFAULTS } from "../config/index.js";

// `index.ts` runs `main()` on import, so the help is exercised the way a
// user reaches it: argv carries `--help`, and `exit` is stubbed out.
vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    ...actual,
    argv: ["node", "atomic-agent", "--help"],
    exit: vi.fn(),
  };
});

// Vite cannot resolve the `node:sea` builtin under test; the help path
// never consults it beyond the debug-argv dump.
vi.mock("node:sea", () => ({ isSea: () => false }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("atomic-agent --help", () => {
  it("states the real completionMaxTokens default for ATOMIC_AGENT_LLAMA_MAX_TOKENS", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    await import("./index.js");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain("ATOMIC_AGENT_LLAMA_MAX_TOKENS");
    });
    const line = chunks
      .join("")
      .split("\n")
      .find((l) => l.includes("ATOMIC_AGENT_LLAMA_MAX_TOKENS"));
    expect(line).toContain(
      `default ${USER_CONFIG_DEFAULTS.localModels.completionMaxTokens},`,
    );
    expect(line).not.toContain("default 8192");
    // Importing the CLI entry pulls in the whole TUI graph.
  }, 60_000);

  it("does not tell Atomic Core users to set ATOMIC_AGENT_LLAMA_API_KEY or llama-server.key", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    // `main()` runs once per module instance; load a fresh one.
    vi.resetModules();
    await import("./index.js");
    await vi.waitFor(() => {
      expect(chunks.join("")).toContain("ATOMIC_AGENT_LLAMA_API_KEY");
    });
    const lines = chunks.join("").split("\n");
    const at = lines.findIndex((l) => l.includes("ATOMIC_AGENT_LLAMA_API_KEY"));
    const entry = lines.slice(at, at + 2).join(" ");
    // The variable and the key file belong to llama-server, not Core.
    expect(entry).not.toContain("managed mode: the daemon runs with it");
    expect(entry).toContain("llama-server");
    expect(entry).toContain("Not needed with Atomic Core");
    expect(entry).not.toContain("\u2014");
  }, 60_000);
});
