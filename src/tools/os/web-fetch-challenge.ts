/**
 * Is this response a bot wall rather than the page that was asked for?
 *
 * `os.web.fetch` is curl with no JavaScript engine, so a site behind
 * Cloudflare, Akamai or PerimeterX does not answer it with the article —
 * it answers with an interstitial whose whole content is "prove you are
 * a browser". Two things went wrong with that before:
 *
 *  1. A challenge served as **200** was extracted and returned as the
 *     page. The model got "Just a moment…" as the body of the article
 *     it asked for and had no way to know it had been fenced out.
 *  2. A challenge served as **403** came back as `HTTP 403 for <url>`,
 *     which is indistinguishable from a page that genuinely refuses
 *     everyone — so the model either gave up on a reachable page or
 *     re-fetched the same wall.
 *
 * Neither says the thing that would actually help, which is that this
 * app has a real browser and the wall is exactly what it is for.
 *
 * Detection is markers-in-body, not status alone: plenty of 403s are
 * ordinary refusals and plenty of challenges are 200s, so the status is
 * corroboration rather than evidence.
 */

/**
 * Phrases that appear in the *visible* text or the meta tags of the
 * interstitials, chosen to be ones a normal article would not contain.
 * Matched case-insensitively against the first slice of the body.
 */
const CHALLENGE_MARKERS: readonly string[] = [
  // Cloudflare
  "just a moment...",
  "checking your browser before accessing",
  "attention required! | cloudflare",
  "cf-browser-verification",
  "cf_chl_opt",
  "/cdn-cgi/challenge-platform/",
  "enable javascript and cookies to continue",
  // Akamai
  "reference #18.",
  "access denied | akamai",
  // PerimeterX / HUMAN
  "px-captcha",
  "please verify you are a human",
  // Imperva / Incapsula
  "incapsula incident id",
  "request unsuccessful. incapsula",
  // Generic
  "ddos protection by",
  "verifying you are human",
  "captcha-delivery.com",
];

/**
 * How much of the body to scan. A challenge page is small and says so
 * immediately; a real article that happens to quote one of these phrases
 * says it well past the first few kilobytes. The cap also keeps this off
 * the hot path for a 2 MB document.
 */
const SCAN_BYTES = 4096;

/** Statuses a challenge is served under. `200` is deliberately included. */
const CHALLENGE_STATUSES = new Set([200, 202, 403, 429, 503]);

export interface ChallengeVerdict {
  challenged: boolean;
  /** The marker that matched, for the message the model reads. */
  marker: string | null;
}

export function detectChallenge(input: {
  status: number;
  contentType: string;
  body: string;
}): ChallengeVerdict {
  if (!CHALLENGE_STATUSES.has(input.status)) {
    return { challenged: false, marker: null };
  }
  // A JSON or plain-text 403 is an API saying no, not a wall asking for
  // a browser. Sending the agent to Chrome for that would be a slower
  // way to get the same refusal.
  const type = input.contentType.toLowerCase();
  if (type.length > 0 && !type.includes("html")) {
    return { challenged: false, marker: null };
  }
  const head = input.body.slice(0, SCAN_BYTES).toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (head.includes(marker)) return { challenged: true, marker };
  }
  return { challenged: false, marker: null };
}

/**
 * What to tell the model. Names the tool that gets through, because the
 * whole failure mode is an agent that does not realise there is one.
 */
export function describeChallenge(
  url: string,
  status: number,
  marker: string,
): string {
  return (
    `${url} answered with a bot-protection challenge (HTTP ${status}, matched ` +
    `"${marker}") rather than the page. This is a JavaScript wall and ` +
    `os.web.fetch cannot pass it. Open the page with browser.navigate and ` +
    `read it with browser.read_aria instead; do not re-fetch this URL.`
  );
}
