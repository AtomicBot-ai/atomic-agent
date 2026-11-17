export function failures(result: Record<string, unknown>, expect?: Record<string, unknown>): string[];
export function check(output: unknown, context?: { vars?: Record<string, unknown> }): { pass: boolean; score: number; reason: string };
