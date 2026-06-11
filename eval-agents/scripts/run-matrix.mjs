#!/usr/bin/env node
// Dispatch to smoke or HF matrix based on ATOMIC_AGENT_GAIA_SOURCE.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./_lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

loadEnv();
const source = process.env.ATOMIC_AGENT_GAIA_SOURCE ?? "fixtures";
const script = source === "hf" ? "run-level1.mjs" : "run-smoke.mjs";
const path = resolve(HERE, script);

const r = spawnSync(process.execPath, [path, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
