import type { EvalCase } from "../harness/case-schema.js";
import { copyGaiaFixture } from "./_gaia-fixtures.js";

/**
 * GAIA-style: same-surname disambiguation. The org-chart PDF lists
 * three people surnamed Smith — Bob (Marketing), Carol (Finance),
 * Alice (Engineering). The naive "first Smith wins" strategy lands
 * on Bob, which is wrong. The agent must restrict the search by
 * department.
 *
 * Bob is intentionally placed FIRST in the document so a model that
 * stops at the first `Smith` match gets the wrong answer. Carol Smith
 * (Finance) is a second distractor to discourage "any non-first
 * Smith" shortcuts. The correct answer is "Alice Smith".
 *
 * Reply shape is constrained ("just the full name") so a verbose
 * answer ("The VP of Engineering is Alice Smith.") still passes
 * because the regex anchors on the literal name with word
 * boundaries; what we strictly reject is "Bob Smith" or "Carol
 * Smith" appearing in the reply (see `must_not_contain`-style
 * negative assertions below — encoded as two extra `reply_contains`
 * with a tightened regex).
 */
export const gaiaPdfDisambiguateName: EvalCase = {
  id: "gaia-pdf-disambiguate-name",
  name: "Disambiguate VP of Engineering by surname Smith",
  category: "gaia-style",
  capabilityAxis: "context_retention",
  prompt:
    "There is a file `org-chart.pdf` in the working directory. The Engineering division is led by someone whose surname is Smith. What is their full name? Reply with just the full name in `First Last` form (no titles, no department).",
  setup: ({ workingDir }) => {
    copyGaiaFixture(workingDir, "org-chart.pdf");
  },
  expectations: [
    { kind: "tool_invoked", tool: "os.fs.read_document", mustSucceed: true },
    // Positive: the correct name must appear.
    { kind: "reply_contains", pattern: /\bAlice\s+Smith\b/i },
    // Negative: the two distractor Smiths must NOT appear. A reply
    // that dumps "Bob Smith — Marketing; Carol Smith — Finance;
    // Alice Smith — Engineering" technically contains the right
    // answer but fails the task framing ("just the full name").
    // Encoded as a single regex with two negative lookaheads (the
    // schema has no `reply_not_contains` kind yet) — the `s` flag
    // makes `.*` cross newlines so multi-line replies are covered.
    {
      kind: "reply_contains",
      pattern: /^(?!.*\bBob\s+Smith\b)(?!.*\bCarol\s+Smith\b).*$/is,
    },
  ],
};
