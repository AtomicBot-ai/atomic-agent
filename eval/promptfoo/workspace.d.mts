export const REPO_ROOT: string;
export type AgentTarget = { kind: "llama-server"; url: string } | { kind: "openrouter"; model: string };
export function currentConfigVersion(repoRoot?: string): number;
export function resolveTarget(env?: Record<string, string | undefined>): AgentTarget | null;
export function buildStateConfig(target: AgentTarget, version?: number): any;
export function seedFiles(root: string, files: Record<string, string> | undefined): void;
export function snapshotFiles(root: string): Record<string, string | null>;
export function sessionIdFromStderr(stderr: string): string | null;
export function toolCallsFromTrace(tracePath: string | null): Array<{ tool: string; status: "ok" | "error"; args: unknown }>;
