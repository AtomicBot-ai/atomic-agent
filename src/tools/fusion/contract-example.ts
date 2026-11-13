/**
 * A provide's example call: the declared function is called once on a
 * small input after the fan-out, and the result is held against what the
 * contract said it returns.
 *
 * Presence (`contract-checks.ts`) and `shape` (`contract.ts`) both stop
 * at words. In one fan-out `PHYS.corners(b)` existed, carried a shape,
 * and was drawn wrong anyway: three scenes of five broken, zero console
 * errors, every check green. A call is the cheapest thing that looks at
 * the value itself, so a provide may now carry
 *
 *   example: { call: "PHYS.corners({x:0,y:0,w:2,h:2,a:0})",
 *              expect: "r.length === 8 && 'w' in r[0] && 'o' in r[0]",
 *              page: "index.html" }
 *
 * and it becomes one more `verify.run` spec next to `contract.checks`,
 * attributed to the provide's task, run by the same runner, in the same
 * throwaway copy. No new runtime:
 *
 * - with `page` (browser code): a `page` run of that file with one probe
 *   that makes the call in the page's global scope and returns `true` or
 *   what went wrong; the check is `probe <name> equals true`.
 * - without `page`: a `command` run of `node` that loads the provide's
 *   `in` file (imported as a module; a plain script that exposes nothing
 *   is run as a script instead) and makes the call there; a mismatch is
 *   printed and exits 1.
 *
 * Opt-in: a contract without examples runs exactly the checks it ran
 * before. An example with nowhere to run (no `page`, no `in`) is a
 * warning on the contract, never a refusal, and runs nothing (F44).
 */

import type {
  ContractCheck,
  ContractProvide,
  ContractProvideExample,
  DelegateContract,
} from "./contract.js";

/** Each of `call` and `expect` is code; code cannot be truncated, so a longer one is refused. */
export const MAX_EXAMPLE_CODE_CHARS = 400;
/** A page example only needs the page to load and one call to land. */
const EXAMPLE_PAGE_SECONDS = 1;
const EXAMPLE_TIMEOUT_MS = 60_000;

function blankToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `provides[i].example` as given, or the problem with it. Absent, `null`
 * and an all-blank `{ call: "", expect: "" }` (a strict provider filling
 * every optional field) are no example at all.
 */
export function parseProvideExample(
  raw: unknown,
  label: string,
): { example?: ContractProvideExample; problem?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: `${label}.example must be an object { call, expect, page? }` };
  }
  const entry = raw as Record<string, unknown>;
  const call = blankToNull(entry.call);
  const expect = blankToNull(entry.expect);
  const page = blankToNull(entry.page);
  if (call === null && expect === null && page === null) return {};
  if (call === null || expect === null) {
    return {
      problem: `${label}.example needs both \`call\` (a JS expression that calls it) and \`expect\` (a JS condition over the result \`r\`)`,
    };
  }
  for (const [field, code] of [["call", call], ["expect", expect]] as const) {
    if (code.length > MAX_EXAMPLE_CODE_CHARS) {
      return {
        problem: `${label}.example.${field} is ${code.length} chars; at most ${MAX_EXAMPLE_CODE_CHARS} — one small call, one condition`,
      };
    }
  }
  return { example: { call, expect, ...(page === null ? {} : { page }) } };
}

/** The examples with nowhere to run: no `page` to open and no `in` to load. */
export function unrunnableExamples(contract: DelegateContract): ContractProvide[] {
  return (contract.provides ?? []).filter(
    (p) => p.example !== undefined && p.example.page === undefined && p.in === undefined,
  );
}

/** `provides "PHYS.corners" (task phys) example cannot run: …` */
export function describeUnrunnableExample(provide: ContractProvide): string {
  return `provides "${provide.name}" (task ${provide.task}) example cannot run: give \`example.page\` (browser code) or \`in\` (a file node can load)`;
}

/** `call` → checked: `expect`, for the briefs. */
export function describeExample(example: ContractProvideExample): string {
  const where = example.page === undefined ? "" : ` in ${example.page}`;
  return `checked after the fan-out by calling \`${example.call}\`${where}; the result r must satisfy \`${example.expect}\``;
}

/**
 * The function both runners evaluate: make the call (awaiting a
 * promise), test the condition, and return `true` or one line saying
 * what went wrong — the line is what lands on the task's row.
 */
const EVALUATE_EXAMPLE = `async (call, expect) => {
  const say = (e) => (e && e.message) ? String(e.message) : String(e);
  let r;
  try { r = await (0, eval)(call); } catch (e) { return "call threw: " + say(e); }
  let ok;
  try { ok = new Function("r", "return (" + expect + ");")(r); } catch (e) { return "expect threw: " + say(e); }
  if (ok) return true;
  let shown;
  try { shown = JSON.stringify(r); } catch (e) { shown = undefined; }
  if (shown === undefined) shown = String(r);
  return "expect was " + String(ok) + " for r = " + shown.slice(0, 300);
}`;

/** The probe a page example samples. Exported for the tests, which run it. */
export function examplePageExpr(example: ContractProvideExample): string {
  return `(${EVALUATE_EXAMPLE})(${JSON.stringify(example.call)}, ${JSON.stringify(example.expect)})`;
}

/** The identifier the call starts from (`PHYS` in `PHYS.corners(…)`), to tell "loaded" from "loaded but not reachable". */
export function exampleRoot(call: string): string | null {
  const root = /^\s*(?:await\s+)?(?:new\s+)?([A-Za-z_$][\w$]*)/.exec(call)?.[1];
  if (root === undefined) return null;
  return ["window", "globalThis", "self", "this", "new", "await", "typeof"].includes(root)
    ? null
    : root;
}

/**
 * The `node --input-type=module -e` script of a module example. The file
 * is imported and its exports (and a CommonJS `module.exports` object's
 * keys) made global; when that leaves the call's root unreachable — a
 * plain script whose top-level `const PHYS` is no export — the file is
 * run once more as a script in this context, where top-level bindings
 * are global. Exported for the tests, which run it.
 */
export function exampleNodeScript(example: ContractProvideExample, file: string): string {
  return [
    `import { readFileSync } from "node:fs";`,
    `import { resolve } from "node:path";`,
    `import { pathToFileURL } from "node:url";`,
    `import vm from "node:vm";`,
    `const file = resolve(${JSON.stringify(file)});`,
    `const root = ${JSON.stringify(exampleRoot(example.call))};`,
    `const reachable = () => { if (root === null) return true; try { return (0, eval)("typeof " + root) !== "undefined"; } catch (e) { return false; } };`,
    `let loadError;`,
    `try { const m = await import(pathToFileURL(file).href); const d = m.default; if (d !== null && typeof d === "object") Object.assign(globalThis, d); for (const [k, v] of Object.entries(m)) if (k !== "default") globalThis[k] = v; } catch (e) { loadError = e; }`,
    `if (!reachable()) { try { vm.runInThisContext(readFileSync(file, "utf8"), { filename: file }); } catch (e) { loadError = loadError ?? e; } }`,
    `if (!reachable()) { console.error("example: " + root + " is not reachable after loading " + ${JSON.stringify(file)} + (loadError === undefined ? "" : " (" + String(loadError && loadError.message || loadError) + ")")); process.exit(1); }`,
    `const verdict = await (${EVALUATE_EXAMPLE})(${JSON.stringify(example.call)}, ${JSON.stringify(example.expect)});`,
    `if (verdict === true) { console.log("example ok"); process.exit(0); }`,
    `console.error("example: " + verdict); process.exit(1);`,
  ].join("\n");
}

/** A check-language token: the provide's name where it is one, else a stand-in. */
function probeName(provide: ContractProvide): string {
  const safe = provide.name.replace(/[^\w$.:-]/g, "_");
  return safe.length > 0 && safe.length <= 80 ? safe : "example";
}

/** The `verify.run` spec of one provide's example, or nothing when it has none or nowhere to run. */
export function exampleCheck(provide: ContractProvide): ContractCheck | undefined {
  const example = provide.example;
  if (example === undefined) return undefined;
  if (example.page !== undefined) {
    const name = probeName(provide);
    return {
      task: provide.task,
      kind: "page",
      path: example.page,
      seconds: EXAMPLE_PAGE_SECONDS,
      timeoutMs: EXAMPLE_TIMEOUT_MS,
      probes: [{ name, expr: examplePageExpr(example) }],
      checks: [`probe ${name} equals true`],
    };
  }
  if (provide.in === undefined) return undefined;
  return {
    task: provide.task,
    kind: "command",
    cmd: "node",
    args: ["--input-type=module", "-e", exampleNodeScript(example, provide.in)],
    timeoutMs: EXAMPLE_TIMEOUT_MS,
  };
}

/** One spec per runnable example, in `provides` order. */
export function contractExampleChecks(contract: DelegateContract): ContractCheck[] {
  return (contract.provides ?? []).flatMap((p) => {
    const check = exampleCheck(p);
    return check === undefined ? [] : [check];
  });
}

/**
 * What the fan-out runs after the waves: the declared `checks` first, so
 * their outcomes keep the indices the judge reads, then the examples.
 */
export function checksWithExamples(contract: DelegateContract): ContractCheck[] {
  return [...(contract.checks ?? []), ...contractExampleChecks(contract)];
}
