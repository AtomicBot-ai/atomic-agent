/**
 * Release-fix checks for backlog item 13 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=13`.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

export async function checks13(js: Js, check: Check): Promise<void> {
  void js; void check;
}
