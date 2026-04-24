/**
 * Lazy loader for `better-sqlite3` that works both in development and inside
 * a Node SEA binary built with `"mainFormat": "module"`.
 *
 * SEA's ESM entry point cannot resolve non-builtin specifiers via static
 * `import` (`ERR_UNKNOWN_BUILTIN_MODULE`), so we route the load through CJS
 * `createRequire` anchored at the executable's directory. The installer
 * ships `node_modules/better-sqlite3` (plus its runtime deps `bindings` and
 * `file-uri-to-path`) alongside the binary so that `createRequire` finds
 * them through the normal Node module resolution.
 *
 * Consumers import the named `Database` value from this module for the
 * runtime constructor. Type references like `BetterSqlite3.Database` or
 * `BetterSqlite3.Statement` keep coming from `better-sqlite3` directly via
 * `import type`, which is erased at build time and therefore has no
 * runtime resolution cost under SEA.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import type BetterSqlite3 from "better-sqlite3";

type DatabaseCtor = typeof BetterSqlite3;

// `node:sea` is a newish built-in and Vite's module graph can't resolve it
// at static import time (tests fail with "Failed to load url sea"). Load it
// dynamically via `createRequire`; in non-SEA contexts the call simply
// fails and we fall back to dev-mode resolution.
const bootRequire = createRequire(import.meta.url);

function isRunningUnderSea(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

let cached: DatabaseCtor | null = null;

function resolveCtor(): DatabaseCtor {
  if (cached) return cached;

  let req: NodeRequire;
  if (isRunningUnderSea()) {
    // The anchor file does not need to exist; `createRequire` only uses
    // it as the resolution root for `node_modules` lookups.
    const anchor = join(dirname(execPath), "__atomic_sea_anchor__.js");
    req = createRequire(anchor);
  } else {
    req = createRequire(import.meta.url);
  }
  cached = req("better-sqlite3") as DatabaseCtor;
  return cached;
}

const DatabaseProxy = new Proxy(function () {} as unknown as DatabaseCtor, {
  apply(_target, _thisArg, args: ConstructorParameters<DatabaseCtor>) {
    return new (resolveCtor())(...args);
  },
  construct(_target, args: ConstructorParameters<DatabaseCtor>) {
    return new (resolveCtor())(...args);
  },
  get(_target, prop, receiver) {
    return Reflect.get(resolveCtor(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(resolveCtor(), prop);
  },
}) as DatabaseCtor;

export const Database: DatabaseCtor = DatabaseProxy;
