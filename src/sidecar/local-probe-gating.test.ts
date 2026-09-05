import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapSidecar } from "./main.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { UserConfigFile } from "../config/index.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import type { SidecarMessage } from "./sidecar-events.js";

/**
 * Issue #112 — `start_session` ran an unconditional local `/health`
 * probe after `buildRuntime` and emitted `llm_unavailable` when nothing
 * answered. On a cloud-backed session that event tells the desktop shell
 * the backend is down for a session that is about to run perfectly.
 *
 * The sidecar is driven the way the host drives it: an NDJSON request
 * pushed at the real stdin stream, the response read off stdout.
 */

const TEXT_PORT = "127.0.0.1:8080";

describe("sidecar start_session — local probe gating", () => {
  let stateDir: string;
  let workingDir: string;
  let previousStateDir: string | undefined;
  let urls: string[];
  let stdout: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-gate-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();

    urls = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      urls.push(url);
      if (url.includes(TEXT_PORT) && url.includes("/props")) {
        return new Response(JSON.stringify(GEMMA4_PROPS), { status: 200 });
      }
      if (url.includes(TEXT_PORT) && url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    // The sidecar speaks NDJSON on the real stdout; capture it instead
    // of letting it interleave with the reporter's output.
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  const writeConfig = (llm: UserConfigFile["llm"]): void => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      analytics: { enabled: false },
      ...(llm ? { llm } : {}),
    });
    resetConfigCache();
  };

  /**
   * Boot the sidecar, push one `start_session`, wait for its response.
   *
   * `bootstrapSidecar` attaches to the process-wide stdin/stdout, and a
   * listener left behind would make the NEXT test's request run through
   * two sidecars at once (two runtimes seeding the same skills dir, and
   * whichever answered first winning the response). So the listeners it
   * adds are recorded and removed on the way out.
   */
  const startSession = async (): Promise<{
    messages: SidecarMessage[];
    shutdown: () => Promise<void>;
  }> => {
    const before = new Map<string, unknown[]>([
      ["stdin:data", process.stdin.listeners("data").slice()],
      ["stdin:end", process.stdin.listeners("end").slice()],
      ["stdout:error", process.stdout.listeners("error").slice()],
      ["stdout:close", process.stdout.listeners("close").slice()],
    ]);
    const detach = (): void => {
      for (const [key, kept] of before) {
        const [target, event] = key.split(":") as ["stdin" | "stdout", string];
        const emitter = target === "stdin" ? process.stdin : process.stdout;
        for (const listener of emitter.listeners(event)) {
          if (!kept.includes(listener)) {
            emitter.removeListener(event, listener as () => void);
          }
        }
      }
    };
    const { shutdown } = await bootstrapSidecar();
    process.stdin.emit(
      "data",
      `${JSON.stringify({
        kind: "request",
        id: "req-1",
        type: "start_session",
        payload: { workingDir },
      })}\n`,
    );
    const deadline = Date.now() + 10_000;
    const parsed = (): SidecarMessage[] =>
      stdout
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SidecarMessage];
          } catch {
            return [];
          }
        });
    while (
      Date.now() < deadline &&
      !parsed().some((m) => m.kind === "response")
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return {
      messages: parsed(),
      shutdown: async () => {
        detach();
        await shutdown();
      },
    };
  };

  it("emits no local health probe or llm_unavailable on a cloud route", async () => {
    writeConfig({
      activeTextProvider: "cloudy",
      activeEmbeddingProvider: "local-llama-embed",
      providers: [
        {
          id: "cloudy",
          kind: "openai-compatible",
          baseUrl: "https://cloud.invalid",
          defaultChatModel: "cloudy-1",
          apiKey: "sk-test",
        },
        { id: "local-llama-embed", kind: "llama-server", url: "http://127.0.0.1:19092" },
      ],
      toolTransport: "auto",
    });

    const { messages, shutdown } = await startSession();
    try {
      expect(
        messages.some((m) => m.kind === "response" && m.ok),
      ).toBe(true);
      expect(urls.filter((u) => u.includes(TEXT_PORT))).toEqual([]);
      expect(
        messages.filter(
          (m) => m.kind === "event" && m.type === "llm_unavailable",
        ),
      ).toEqual([]);
    } finally {
      await shutdown();
    }
  });

  it("still probes on a local route (the control)", async () => {
    writeConfig(undefined);
    const { messages, shutdown } = await startSession();
    try {
      expect(messages.some((m) => m.kind === "response" && m.ok)).toBe(true);
      // Boot's `/health` + `/props`, then start_session's own `/health`.
      expect(
        urls.filter((u) => u.includes(TEXT_PORT) && u.includes("/health"))
          .length,
      ).toBe(2);
    } finally {
      await shutdown();
    }
  });
});
