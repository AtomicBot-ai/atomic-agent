import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

const CART_SOURCE = [
  "export interface CartItem {",
  "  price: number;",
  "  quantity: number;",
  "}",
  "",
  "export function calculateTotal(items: CartItem[]): number {",
  "  return items.length;",
  "}",
  "",
].join("\n");

export const codingFixCartTotal: EvalCase = {
  id: "coding-fix-cart-total",
  name: "Fix a single-file cart total bug",
  category: "coding",
  prompt:
    "Fix the bug in src/cart.ts. calculateTotal must return the sum of price * quantity for every cart item. Keep the public interface unchanged and tell me what you changed.",
  setup: ({ workingDir }) => {
    const src = join(workingDir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cart.ts"), CART_SOURCE, "utf8");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read", mustSucceed: true },
    { kind: "file_matches", path: "src/cart.ts", pattern: /price\s*\*\s*(?:item\.)?quantity|quantity\s*\*\s*(?:item\.)?price/ },
    { kind: "file_matches", path: "src/cart.ts", pattern: /reduce|for\s*\(/ },
  ],
};
