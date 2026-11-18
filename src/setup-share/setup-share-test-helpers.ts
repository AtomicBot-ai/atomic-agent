import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract as tarExtract, pack as tarPack, type Headers } from "tar-stream";

/** Test-only helpers for the setup-share tests: fixture state dirs and raw tar access. */

export const SECRET = "sk-test-0123456789abcdefSECRET";

export function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A state dir with one of everything: shareable parts, personal parts and stray files. */
export function makeStateDir(dir: string): void {
  put(dir, "config.json", JSON.stringify({
    mcp: {
      servers: [
        {
          name: "github",
          enabled: true,
          approval: "auto",
          trust: "pure_read",
          env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123", LOG_LEVEL: "debug" },
          transport: { kind: "stdio", command: "github-mcp", args: ["--api-key", SECRET, "--token=hunter2", "--verbose"] },
        },
        {
          name: "remote",
          enabled: true,
          transport: { kind: "streamable_http", url: "https://user:pw@mcp.example.com/mcp?api_key=abc&team=a", headers: { Authorization: `Bearer ${SECRET}` } },
        },
      ],
    },
    llm: {
      providers: [
        { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: SECRET, apiKeyEnvVar: "GROQ_API_KEY" },
      ],
    },
    agent: {
      personas: {
        active: "pirate",
        projects: { "/Users/me/secret-project": "pirate" },
        definitions: { pirate: { instructions: "Talk like a pirate." } },
      },
    },
    channels: { telegram: { botToken: "123:telegram-secret" } },
  }));
  put(dir, ".env", `OPENAI_API_KEY=${SECRET}\n`);
  put(dir, "sessions.sqlite", "chats");
  put(dir, "memory.sqlite", "memory-bytes");
  put(dir, "agent.log", "log");
  put(dir, "stray-notes.txt", "not part of a setup");
  put(dir, "mcp-oauth/github.json", `{"access_token":"${SECRET}"}`);
  put(dir, "traces/t1.jsonl", "{}");
  put(dir, "skills/triage/SKILL.md", "---\nname: triage\ndescription: Sort the inbox\n---\n\n# triage\n");
  put(dir, "skills/triage/scripts/run.sh", "#!/bin/sh\necho sorting\n");
  put(dir, "skills/triage/.env", `KEY=${SECRET}\n`);
  put(dir, "skills/triage/node_modules/x/index.js", "module.exports = 1;\n");
  put(dir, "skills/skill-creator/SKILL.md", "---\nname: skill-creator\ndescription: starter\n---\n");
  put(dir, "agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews diffs\n---\nReview the diff.\n");
}

/** Every file entry of a `.tar.gz` as name -> content. */
export async function readTar(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ex = tarExtract();
  ex.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      if (header.type === "file") out.set(header.name, Buffer.concat(chunks).toString("utf8"));
      next();
    });
  });
  await pipeline(createReadStream(file), createGunzip(), ex);
  return out;
}

/** Write a hand-made `.tar.gz`, for bundles the exporter would never produce. */
export async function writeTar(file: string, entries: Array<{ header: Headers; content?: string }>): Promise<void> {
  const pack = tarPack();
  const done = pipeline(pack, createGzip(), createWriteStream(file));
  for (const e of entries) pack.entry(e.header, e.content ?? "");
  pack.finalize();
  await done;
}

export function manifestFor(paths: string[]): string {
  return JSON.stringify({
    format: "atomic-agent-setup",
    version: 1,
    createdAt: "2026-11-18T00:00:00.000Z",
    appVersion: null,
    contents: { skills: [], agents: [], mcpServers: [], providers: [], personas: [], memory: false },
    redacted: [],
    leftOut: [],
    files: paths.map((path) => ({ path, size: 0 })),
  });
}
