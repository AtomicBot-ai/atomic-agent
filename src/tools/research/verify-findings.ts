import { checkNumbers, normalizeForQuote, quoteAppearsIn } from "./evidence-check.js";
import type { Finding, UnverifiedFinding, VerifiedFinding } from "./research-types.js";

/**
 * Sort findings into verified and unverified (ATO-2133). `pageTextOf`
 * returns the text fetched for a URL in this run; a finding whose URL
 * was not fetched cannot be checked and is unverified. Pure.
 */
export function verifyFindings(
  findings: readonly Finding[],
  pageTextOf: (url: string) => string | undefined,
): { verified: VerifiedFinding[]; unverified: UnverifiedFinding[] } {
  const verified: VerifiedFinding[] = [];
  const unverified: UnverifiedFinding[] = [];
  for (const finding of findings) {
    const page = pageTextOf(finding.url);
    const quote = page === undefined ? null : quoteAppearsIn(finding.quote, page);
    if (quote === null || !quote.found) {
      const reason = quote !== null && !quote.found && quote.reason === "too_short" ? "quote_too_short" : "quote_not_on_page";
      unverified.push({ ...finding, reason });
      continue;
    }
    const numbers = checkNumbers(finding.claim, finding.quote);
    if (!numbers.ok) {
      unverified.push({ ...finding, reason: "number_not_in_quote", unsupportedNumbers: numbers.unsupported });
      continue;
    }
    verified.push({ ...finding, derived: numbers.derived });
  }
  return { verified, unverified };
}

/**
 * One copy of each finding: two sub-questions that read the same page
 * often return the same claim and quote. The first (lowest sub-question)
 * is kept.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.url}\n${normalizeForQuote(f.quote)}\n${normalizeForQuote(f.claim)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
