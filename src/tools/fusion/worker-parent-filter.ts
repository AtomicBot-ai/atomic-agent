/**
 * A worker turn's `toolFilter` with its parent turn's on top (ATO-2440):
 * a tool must pass both. `run --disallowed-tools os.shell.run` hides the
 * shell from the chat's own turn; without this a `subagent.run` or
 * `fusion.delegate` worker would still get it, since its filter is built
 * from the worker policy and the profile only (`workerToolFilterFor`).
 * It only ever narrows: no parent filter, the worker's as it was.
 */
export function withParentToolFilter(
  worker: (name: string) => boolean,
  parent: ((name: string) => boolean) | undefined,
): (name: string) => boolean {
  return parent === undefined ? worker : (name) => worker(name) && parent(name);
}
