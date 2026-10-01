import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  getEmbeddingModelDef,
} from "../local-llm/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";

/**
 * Issue #582 follow-up. The managed embedding daemon requires the key,
 * and `/health` is exempt from it — so a bootstrap whose embedding client
 * sent no key passed its probe, then got 401 on every `/embedding` and
 * silently fell back to FTS5-only recall. This boots the real runtime
 * against a key-guarded fake daemon and embeds once.
 */

const EMBED_HOST = "127.0.0.1:19092";

describe("bootstrap embedding client authenticates to the managed daemon (#582)", () => {
  let stateDir: string;
  let workingDir: string;
  const embedAuth: Array<string | null> = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-embed-auth-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-embed-auth-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    embedAuth.length = 0;
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      analytics: { enabled: false },
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        embeddings: {
          ...USER_CONFIG_DEFAULTS.localModels.embeddings,
          enabled: true,
          modelId: DEFAULT_EMBEDDING_MODEL_ID,
        },
      },
      memory: {
        ...USER_CONFIG_DEFAULTS.memory,
        embeddings: { ...USER_CONFIG_DEFAULTS.memory.embeddings, enabled: true },
      },
    });
    resetConfigCache();
    const dim = getEmbeddingModelDef(DEFAULT_EMBEDDING_MODEL_ID).dim;
    const keyFile = join(stateDir, "models", "llama-server.key");
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(EMBED_HOST) && url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.includes(EMBED_HOST) && url.endsWith("/embedding")) {
        const auth =
          ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
        embedAuth.push(auth);
        // The daemon's view: only the key it was launched with gets in.
        const key = readFileSync(keyFile, "utf-8").trim();
        if (auth !== `Bearer ${key}`) {
          return new Response(JSON.stringify({ error: "Invalid API Key" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({ embedding: Array.from({ length: dim }, () => 0.1) }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("sends the persisted key on /embedding, so hybrid recall stays on", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: new FakeBrowserBackend(),
        disableStreaming: true,
      },
    });
    try {
      const entry = runtime.notesStore.store({ content: "the user prefers tabs" });
      embedAuth.length = 0; // drop the fire-and-forget write from store()
      expect(await runtime.notesStore.writeEmbeddingFor(entry.id, entry.content)).toBe(true);
      expect(embedAuth.at(-1)).toMatch(/^Bearer [0-9a-f]{64}$/);
    } finally {
      await runtime.shutdown();
    }
  });
});
