import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const TAX_SOURCE = [
  "export const TAX_RATE = 0.2;",
  "",
  "export function calculateTax(subtotal: number): number {",
  "  return subtotal * TAX_RATE;",
  "}",
  "",
].join("\n");

const INVOICE_SOURCE = [
  "export function invoiceTotal(subtotal: number): number {",
  "  const tax = subtotal * 0.18;",
  "  return subtotal + tax;",
  "}",
  "",
].join("\n");

export const codingWireSharedTaxRate: EvalCase = {
  id: "coding-wire-shared-tax-rate",
  name: "Use a shared constant across files",
  category: "coding",
  prompt:
    "The invoice calculation uses the wrong hardcoded tax rate. Find the shared tax constant in src/tax.ts and update src/invoice.ts to use it instead of a number literal. Keep calculateTax unchanged.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "tax.ts"), TAX_SOURCE, "utf8");
    writeFileSync(join(src, "invoice.ts"), INVOICE_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "file_matches", path: "src/invoice.ts", pattern: /import\s+\{\s*TAX_RATE\s*\}/ },
    { kind: "file_matches", path: "src/invoice.ts", pattern: /subtotal\s*\*\s*TAX_RATE/ },
    { kind: "file_matches", path: "src/tax.ts", pattern: /export const TAX_RATE = 0\.2/ },
  ],
};
