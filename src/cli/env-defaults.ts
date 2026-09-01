/**
 * Defaults `NODE_ENV` to `"production"` before React can read it.
 *
 * React ships as two builds behind a runtime
 * `process.env.NODE_ENV === "production" ? prod : dev` switch, and the
 * development reconciler calls `performance.measure()` for every
 * component render. Node keeps every user-timing entry alive for the
 * life of the process, and the TUI redraws on a timer even while idle,
 * so a `dist` run with `NODE_ENV` unset — the default outcome of
 * `npm run build` + `node dist/cli/index.js` — grows the heap without
 * bound and aborts with `FATAL ERROR: Ineffective mark-compacts near
 * heap limit` roughly eleven hours after boot (issue #307).
 *
 * The SEA binary is immune because `scripts/bundle-sea.ts` inlines the
 * same constant as an esbuild define; this module is the equivalent for
 * the unbundled paths (`dist/cli/index.js`, `npm run cli`, `dev:cli`),
 * which `tsc` compiles without defines.
 *
 * It must be the **first import of the CLI entrypoint**: ES modules
 * evaluate imports depth-first before the importer's body, so by the
 * time any statement in `index.ts` runs, the `tuiCommand` import chain
 * has already loaded `react-reconciler` and the build choice is made.
 * Only this position runs early enough. `env-defaults.test.ts` guards
 * the ordering.
 *
 * An explicitly exported `NODE_ENV` — `development` for React
 * debugging, `test` under a runner — is left alone.
 */
process.env.NODE_ENV ??= "production";
