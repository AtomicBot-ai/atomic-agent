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
 */

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
}

export interface ContractRequire {
  /** The task that relies on it. */
  task: string;
  /** Matches a `provides[].name` exactly. */
  name: string;
}

/**
 * One `verify.run` spec, plus the task it is attributed to. The spec's
 * own keys are owned by the verify tool and pass through untouched.
 */
export type ContractCheck = { task?: string } & Record<string, unknown>;

export interface DelegateContract {
  /** Path → task id. Nobody else writes there. */
  owners?: Record<string, string>;
  provides?: ContractProvide[];
  requires?: ContractRequire[];
  checks?: ContractCheck[];
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
  return `${provide.kind} ${provide.name}${where}`;
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
 * checks. Measured against `MAX_CONTRACT_RENDERED_CHARS` at parse time.
 */
export function renderContractBlock(contract: DelegateContract): string {
  const lines = [
    `CONTRACT — the interface between the parts of this fan-out. Every worker sees this same block. Produce exactly what it says you provide, under exactly these names, and reach the other parts only through what they provide.`,
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
  const requires = contract.requires ?? [];
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
  return lines.join("\n");
}

/**
 * The three lines that turn the shared block into this worker's own
 * obligations. A require is resolved to the provide it names so the
 * worker knows who produces it and where to find it.
 */
export function renderContractForTask(
  contract: DelegateContract,
  taskId: string,
): string {
  const owned = ownedPaths(contract, taskId);
  const provides = (contract.provides ?? []).filter((p) => p.task === taskId);
  const relies = (contract.requires ?? [])
    .filter((r) => r.task === taskId)
    .map((r) => {
      const source = (contract.provides ?? []).find((p) => p.name === r.name);
      return source === undefined
        ? r.name
        : `${r.name} (${source.kind} from ${source.task}${source.in === undefined ? "" : ` in ${source.in}`})`;
    });
  return [
    `You own: ${owned.length > 0 ? owned.join(", ") : "no path in this contract — write only the files your TASK names"}`,
    `You provide: ${provides.length > 0 ? provides.map(describeProvide).join("; ") : "nothing listed"}`,
    `You may rely on: ${relies.length > 0 ? relies.join("; ") : "nothing from the other parts"}`,
  ].join("\n");
}
