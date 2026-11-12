import type { SubscriptionCliStatusReport } from "../../llm/provider/subscription-cli/index.js";

/**
 * ATO-1204: the one status line under the subscription CLI step of the
 * terminal providers wizard. Pure, so it is tested without ink: the answer
 * comes from `checkSubscriptionCli` (the same check as `providers status`).
 */
export type StatusLineTone = "ok" | "warn" | "muted";

export function subscriptionCliStatusLine(
  report: SubscriptionCliStatusReport | null,
  cli: string,
): { text: string; tone: StatusLineTone } {
  if (!report) return { text: `Checking the ${cli} CLI…`, tone: "muted" };
  const product = report.productName;
  switch (report.state) {
    case "ready":
      return { text: `✓ ready: ${product}${report.version ? ` ${report.version}` : ""}, signed in`, tone: "ok" };
    case "missing":
      return { text: `${product} is not installed. Install it: ${report.fix ?? ""}`.trim(), tone: "warn" };
    case "signed_out":
      return {
        text: report.apiKeyLogin
          ? `${product} uses an API key (bills per token). Sign in with ChatGPT: ${report.fix ?? ""}`.trim()
          : `${product} is not signed in. Run: ${report.fix ?? ""}`.trim(),
        tone: "warn",
      };
    case "unknown":
    default:
      return { text: `${product} is installed; can't verify the login without spending your plan.`, tone: "muted" };
  }
}
