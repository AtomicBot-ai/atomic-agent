// Small shared helpers for the small-model bench. Plain Node ESM, no deps,
// so the runner works from a fresh checkout without `npm ci`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Deterministic 32-bit PRNG (mulberry32). Same seed -> same fixture bytes. */
export function makeRng(seed) {
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    hex(len) {
      let s = "";
      while (s.length < len) s += Math.floor(next() * 16).toString(16);
      return s;
    },
    code(len) {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let s = "";
      for (let i = 0; i < len; i += 1) s += abc[Math.floor(next() * abc.length)];
      return s;
    },
  };
}

function hashSeed(seed) {
  const h = createHash("sha256").update(String(seed)).digest();
  return h.readUInt32LE(0);
}

/** Write a { "rel/path": "content" } map under `dir`. Keys ending in `!x` get mode 755. */
export function writeFiles(dir, files) {
  for (const [rawRel, content] of Object.entries(files)) {
    const exec = rawRel.endsWith("!x");
    const rel = exec ? rawRel.slice(0, -2) : rawRel;
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (exec) chmodSync(path, 0o755);
  }
}

export function readText(dir, rel) {
  const path = join(dir, rel);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Strip all whitespace (port of `tr -d ' \t\r\n'` in the old checker). */
export function squash(text) {
  return text === null ? null : text.replace(/[ \t\r\n]/g, "");
}

/** Last non-empty line, CR stripped. */
export function lastLine(text) {
  if (text === null) return null;
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : "";
}

/** Run a command with a hard timeout; never throws. */
export function run(cmd, args, { cwd, timeoutMs = 20_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  return {
    code: r.status,
    stdout: (r.stdout ?? "").replace(/\r/g, ""),
    stderr: (r.stderr ?? "").replace(/\r/g, ""),
    timedOut: r.error?.code === "ETIMEDOUT",
  };
}

export const pass = () => ({ pass: true, reason: "" });
export const fail = (reason) => ({ pass: false, reason });

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Short one-line clip for reasons in tables. */
export function clip(text, n = 60) {
  if (text === null || text === undefined) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
