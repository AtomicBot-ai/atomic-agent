/**
 * Default `NODE_ENV` to `production` before anything else loads.
 *
 * React ships two builds behind a runtime
 * `process.env.NODE_ENV === "production" ? prod : dev` switch.
 * `scripts/bundle-sea.ts` defines the constant away for the SEA binary,
 * so a released install always gets the production reconciler. Every
 * other way of starting the CLI — `node dist/cli/index.js`, `npm run
 * cli`, `npm run dev:cli`, a `npx`/`npm link` checkout — leaves NODE_ENV
 * unset, which is how `react-reconciler` resolves to its *development*
 * build on machines whose shell does not export it. That is every
 * machine.
 *
 * The development reconciler carries React 19's Component Performance
 * Track: eight `performance.measure()` call sites, fired on every
 * commit. The production build has none. A TUI commits continuously —
 * spinners, timers, streaming deltas — and nothing in Node ever drains
 * the global performance entry buffer, so the entries accumulate for the
 * life of the process at roughly 35-40 per second. Node warns at one
 * million (`MaxPerformanceEntryBufferExceededWarning`), and V8 aborts at
 * its ~4 GB ceiling: `FATAL ERROR: Ineffective mark-compacts near heap
 * limit`, a native abort with no JS stack, around the eleven-hour mark.
 * An unattended agent simply goes silent, and takes its tmux server with
 * it if that was the only session.
 *
 * An explicit NODE_ENV is always honoured — this only fills in the
 * blank.
 *
 * **This module must stay the first import in `src/cli/index.ts`.** ES
 * module bodies run after their whole dependency graph is evaluated, so
 * assigning `process.env.NODE_ENV` from inside `index.ts` would land
 * long after `ink` had already required the reconciler and chosen a
 * build. Only a side-effect import placed ahead of the others runs early
 * enough. `src/cli/node-env-bootstrap.test.ts` guards the ordering.
 */

/**
 * Set `env.NODE_ENV` to `production` when it carries no value.
 *
 * @returns whether the default was applied.
 */
export function applyProductionNodeEnvDefault(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== "") return false;
  env.NODE_ENV = "production";
  return true;
}

applyProductionNodeEnvDefault(process.env);
