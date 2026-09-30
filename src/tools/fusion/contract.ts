/**
 * The contract between the parts of one fan-out.
 *
 * Workers never see each other. In one benchmark that cost two whole
 * turns: one worker wrote `HD.Ship` as a class while its sibling called
 * it as an object, and a `launch-btn` in `main.js` looked for a
 * `btn-launch` in the markup. Each brief was internally consistent; the
 * disagreement lived between them, where nothing was written down.
 *
 * A contract writes it down once, in language-agnostic terms: who owns
 * which path, what each task must produce (a symbol in a file, a file,
 * an id in the markup, an endpoint, an env var, a CLI flag), what a task
 * may rely on from the others, and which `verify.run` checks the whole
 * must pass. It is prepended to every brief (`worker-prompt.ts`) and
 * checked for presence after the fan-out (`contract-checks.ts`).
 *
 * Presence is all this module can promise. A grep sees that `HD.Ship`
 * appears in `js/ship.js`; whether it is a class or an object is what
 * `checks` — a runtime — is for.
 *
 * Two things the contract can declare are *warnings*, not refusals
 * (F44): a `requires` entry that names nothing any task provides, and a
 * non-file `provides` entry with nowhere to be looked for (no `in`, no
 * owned path, no declared file). Each used to reject the whole call,
 * and a local orchestrator at ~5 tok/s paid four minutes of generation
 * per refusal to learn about one name — the third and fourth
 * consecutive refusals of one afternoon. Nothing about either stops the
 * fan-out from running: `contractWarnings` names them, the parser
 * stores them on the contract, `renderContractBlock` appends them to
 * the block every worker reads (the per-task "You may rely on" line
 * drops an unprovided require; an uncheckable provide stays listed as
 * declared), the presence check skips what it cannot check, and the
 * same notes come back on the result's `contract:` line so the
 * orchestrator can fix the contract on its next call, with the work
 * already done.
 */

import { renderContractInputs } from "./contract-inputs.js";

/** What a `provides` entry can name. `file` uses `name` as the path. */
export const CONTRACT_PROVIDE_KINDS = [
  "symbol",
  "file",
  "id",
  "endpoint",
  "env",
  "flag",
  "other",
] as const;

export type ContractProvideKind = (typeof CONTRACT_PROVIDE_KINDS)[number];

export interface ContractProvide {
  /** The task that must produce it. */
  task: string;
  kind: ContractProvideKind;
  /** The literal name: `HD.Ship.reset`, `btn-launch`, `/api/score`, `js/hud.js`. */
  name: string;
  /** Where it must appear. Absent: any path the task owns (or declares). */
  in?: string;
  /**
   * What the thing IS, in one line: a signature, a return shape, a field
   * meaning. Optional, and the only part of a provide that carries
   * semantics rather than identity.
   *
   * It exists because matching names is not matching meaning. Two
   * workers in one fan-out both implemented `PHYS.corners(b)` and both
   * satisfied the name contract; the producer returned
   * `{w: world point, o: local offset}` and the consumer projected `o`
   * as if it were the world point, so every box drew at the origin while
   * the shadows — read straight from `pos` — landed correctly. Nothing
   * errored, the page loaded, and the automated checks were green.
   *
   * One line in the CONSUMER's brief is what closes that. Reading the
   * producer's file instead costs a whole worker turn at 4 tok/s, which
   * is the reason the briefs said "write first, no reading" in the first
   * place.
   */
  shape?: string;
}

/**
 * How long a `shape` may be. It is untrusted model text pasted into
 * every consumer's brief, and a line is what it is for — a paragraph
 * belongs in `instructions`.
 */
export const MAX_PROVIDE_SHAPE_CHARS = 200;

export interface ContractRequire {
  /** The task that relies on it. */
  task: string;
  /**
   * Should match a `provides[].name` exactly. One that matches none is
   * carried through as written and reported by `contractWarnings`.
   */
  name: string;
}

/**
 * One `verify.run` spec, plus the task it is attributed to. The spec's
 * own keys are owned by the verify tool and pass through untouched.
 */
export type ContractCheck = { task?: string } & Record<string, unknown>;

export interface DelegateContract {
  /** The operator's own files: edited in place by any worker, replaced by none (`contract-inputs.ts`). */
  inputs?: string[];
  /** Path → task id. Nobody else writes there. */
  owners?: Record<string, string>;
  provides?: ContractProvide[];
  requires?: ContractRequire[];
  checks?: ContractCheck[];
  /**
   * What the contract declares that cannot be honoured, and the call
   * ran with anyway — `contractWarnings`, computed once by
   * `parseDelegateArgs` because one of them needs the tasks' declared
   * files. Rendered at the end of every worker's block and carried to
   * the result's `contract:` line and `details.contract.warnings`. A
   * contract built by hand carries none unless it says so.
   */
  warnings?: string[];
}

export const MAX_CONTRACT_PROVIDES = 64;
export const MAX_CONTRACT_CHECKS = 16;
/** Bound on the shared block every worker pays for in its context. */
export const MAX_CONTRACT_RENDERED_CHARS = 8000;

/** How much of one check's JSON the brief shows. */
const CHECK_RENDER_CHARS = 300;

/** `symbol HD.Ship in js/ship.js` — the same phrase everywhere. */
export function describeProvide(provide: ContractProvide): string {
  const where = provide.in === undefined ? "" : ` in ${provide.in}`;
  const shape = provide.shape === undefined ? "" : ` — ${provide.shape}`;
  return `${provide.kind} ${provide.name}${where}${shape}`;
}

/** Paths a task owns, in declaration order. */
export function ownedPaths(
  contract: DelegateContract,
  taskId: string,
): string[] {
  return Object.entries(contract.owners ?? {})
    .filter(([, owner]) => owner === taskId)
    .map(([path]) => path);
}

/** Globs are patterns, not paths — never somewhere a provide can be looked for. */
const GLOB_CHARS = /[*?[\]{}]/;

/** The one thing a task contributes to where its provides are looked for. */
export interface ContractTaskFiles {
  id: string;
  files?: readonly string[];
}

/**
 * Where a non-file provide is looked for: `in`, else the paths its task
 * owns, else the files its task declared — globs excluded at every
 * step. Empty means it cannot be checked at all; the parser warns about
 * that and the presence check skips it, both through this one rule.
 */
export function provideSearchPaths(
  provide: ContractProvide,
  contract: DelegateContract,
  task: ContractTaskFiles | undefined,
): string[] {
  if (provide.in !== undefined) return [provide.in];
  const owned = ownedPaths(contract, provide.task).filter(
    (p) => !GLOB_CHARS.test(p),
  );
  if (owned.length > 0) return owned;
  return (task?.files ?? []).filter((f) => !GLOB_CHARS.test(f));
}

/** The non-file `provides` entries with nowhere to be looked for, in declaration order. */
export function uncheckableProvides(
  contract: DelegateContract,
  tasks: readonly ContractTaskFiles[],
): ContractProvide[] {
  return (contract.provides ?? []).filter(
    (p) =>
      p.kind !== "file" &&
      provideSearchPaths(
        p,
        contract,
        tasks.find((t) => t.id === p.task),
      ).length === 0,
  );
}

/** `provides "done" (task organize) cannot be checked: no \`in\`, no owned path, no declared files` */
export function describeUncheckableProvide(provide: ContractProvide): string {
  return `provides "${provide.name}" (task ${provide.task}) cannot be checked: no \`in\`, no owned path, no declared files`;
}

function isProvided(contract: DelegateContract, require: ContractRequire): boolean {
  return (contract.provides ?? []).some((p) => p.name === require.name);
}

/** The `requires` entries no `provides` entry satisfies, in declaration order. */
export function unprovidedRequires(
  contract: DelegateContract,
): ContractRequire[] {
  return (contract.requires ?? []).filter((r) => !isProvided(contract, r));
}

/** `requires "organized_files" (task index) has no provider — nothing produces it` */
export function describeUnprovidedRequire(require: ContractRequire): string {
  return `requires "${require.name}" (task ${require.task}) has no provider — nothing produces it`;
}

/**
 * What the contract declares that cannot be honoured, one line each,
 * without the `contract:` prefix — the result's `contract:` line and
 * `details.contract.warnings` carry them as they are; the worker's
 * block prefixes them itself. Provides first, then requires, each in
 * declaration order. Empty for a contract with nothing to warn about,
 * so a caller can test the length.
 */
export function contractWarnings(
  contract: DelegateContract,
  tasks: readonly ContractTaskFiles[],
): string[] {
  return [
    ...uncheckableProvides(contract, tasks).map(describeUncheckableProvide),
    ...unprovidedRequires(contract).map(describeUnprovidedRequire),
  ];
}

function renderCheck(check: ContractCheck): string {
  const { task, ...spec } = check;
  const json = JSON.stringify(spec);
  const clipped =
    json.length > CHECK_RENDER_CHARS
      ? `${json.slice(0, CHECK_RENDER_CHARS)}…`
      : json;
  return task === undefined ? `- ${clipped}` : `- [${task}] ${clipped}`;
}

/**
 * The block shared by every worker: all owners, provides, requires and
 * checks, then the contract's `warnings`, one `contract: …` line each,
 * so no worker waits for or goes looking for something no sibling was
 * asked to make. Measured against `MAX_CONTRACT_RENDERED_CHARS` at
 * parse time, warnings included.
 */
export function renderContractBlock(contract: DelegateContract): string {
  const lines = [
    `CONTRACT — the interface between the parts of this fan-out. Every worker sees this same block. Produce exactly what it says you provide, under exactly these names, and reach the other parts only through what they provide.`,
    ...renderContractInputs(contract.inputs),
  ];
  const owners = Object.entries(contract.owners ?? {});
  if (owners.length > 0) {
    lines.push(
      `OWNERS (path → task; write only in paths you own):`,
      ...owners.map(([path, task]) => `- ${path} → ${task}`),
    );
  }
  const provides = contract.provides ?? [];
  if (provides.length > 0) {
    lines.push(
      `PROVIDES:`,
      ...provides.map((p) => `- [${p.task}] ${describeProvide(p)}`),
    );
  }
  // Only the requires somebody provides are listed as requirements; an
  // unmatched one is the note at the end, not a dependency a worker
  // could wait on.
  const requires = (contract.requires ?? []).filter((r) =>
    isProvided(contract, r),
  );
  if (requires.length > 0) {
    const byTask = new Map<string, string[]>();
    for (const r of requires) {
      byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.name]);
    }
    lines.push(
      `REQUIRES:`,
      ...[...byTask].map(([task, names]) => `- [${task}] ${names.join(", ")}`),
    );
  }
  const checks = contract.checks ?? [];
  if (checks.length > 0) {
    lines.push(
      `CHECKS (run after the fan-out; a failing check fails its task):`,
      ...checks.map(renderCheck),
    );
  }
  lines.push(...(contract.warnings ?? []).map((w) => `contract: ${w}`));
  return lines.join("\n");
}

/**
 * The three lines that turn the shared block into this worker's own
 * obligations. A require is resolved to the provide it names so the
 * worker knows who produces it and where to find it; one that resolves
 * to nothing is left off the line (the block's note covers it), because
 * "you may rely on X" over an X nobody makes is a promise to a worker
 * that cannot ask.
 */
export function renderContractForTask(
  contract: DelegateContract,
  taskId: string,
): string {
  const owned = ownedPaths(contract, taskId);
  const provides = (contract.provides ?? []).filter((p) => p.task === taskId);
  const relies = (contract.requires ?? [])
    .filter((r) => r.task === taskId)
    .flatMap((r) => {
      const source = (contract.provides ?? []).find((p) => p.name === r.name);
      // The shape travels to the CONSUMER, which is the half that was
      // missing: the producer knows what it returns, the consumer is the
      // one that has to agree about it.
      return source === undefined
        ? []
        : [
            `${r.name} (${source.kind} from ${source.task}${source.in === undefined ? "" : ` in ${source.in}`})${source.shape === undefined ? "" : ` — ${source.shape}`}`,
          ];
    });
  return [
    `You own: ${owned.length > 0 ? owned.join(", ") : "no path in this contract — write only the files your TASK names"}`,
    `You provide: ${provides.length > 0 ? provides.map(describeProvide).join("; ") : "nothing listed"}`,
    `You may rely on: ${relies.length > 0 ? relies.join("; ") : "nothing from the other parts"}`,
  ].join("\n");
}
