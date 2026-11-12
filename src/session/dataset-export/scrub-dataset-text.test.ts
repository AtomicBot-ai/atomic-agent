import { describe, expect, it } from "vitest";

import { createDatasetScrubber, totalRedactions } from "./scrub-dataset-text.js";

// Built from parts so secret scanners do not take the fixtures for keys.
const OPENAI = "sk-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
const SK_NO_DIGIT = "sk-" + "abcdefghijklmnopqrstuv";
const GITHUB = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
const SLACK = "xox" + "b-" + "123456789012-1234567890123-Ab12Cd34Ef56Gh78";
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT =
  "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
// Too short for the shared detector, which wants 16 characters.
const BEARER = "Ab12Cd34" + "Ef";

const HOME = "/Users/nadya";

describe("createDatasetScrubber (ATO-1104)", () => {
  it.each([
    ["an OpenAI key", `my key is ${OPENAI}, use it`],
    ["an sk- key without a digit", `try ${SK_NO_DIGIT} please`],
    ["a GitHub token", `GITHUB=${GITHUB}`],
    ["a Slack token", `slack ${SLACK} here`],
    ["an AWS access key", `aws ${AWS}`],
    ["a JWT", `token ${JWT}`],
    ["a short bearer token", `curl -H "Authorization: Bearer ${BEARER}"`],
    ["a bearer token in prose", `send Bearer ${BEARER} with it`],
  ])("replaces %s", (_name, text) => {
    const scrubber = createDatasetScrubber({ homeDir: HOME });
    const out = scrubber.scrub(text);
    for (const secret of [OPENAI, SK_NO_DIGIT, GITHUB, SLACK, AWS, JWT, BEARER]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted:");
    expect(scrubber.counts.secrets).toBe(1);
  });

  it("replaces an exact value the agent knows is secret, whatever its shape", () => {
    const scrubber = createDatasetScrubber({
      homeDir: HOME,
      known: [{ label: "MY_SERVICE_KEY", value: "plainvaluewithnoshape" }],
    });
    expect(scrubber.scrub("it is plainvaluewithnoshape")).toBe("it is [redacted:MY_SERVICE_KEY]");
    expect(scrubber.counts.secrets).toBe(1);
  });

  it("replaces emails and home folders, the user's own and anyone else's", () => {
    const scrubber = createDatasetScrubber({ homeDir: HOME });
    const out = scrubber.scrub(
      "mail nadya@example.com, open /Users/nadya/proj/a.ts and /home/bob/x and C:\\Users\\ann\\y",
    );
    expect(out).toBe("mail <email>, open ~/proj/a.ts and ~/x and ~\\y");
    expect(scrubber.counts).toEqual({ secrets: 0, emails: 1, homePaths: 3 });
  });

  it("keeps a home folder's longer sibling apart and handles a home outside /Users", () => {
    const scrubber = createDatasetScrubber({ homeDir: "/var/home/nadya" });
    expect(scrubber.scrub("cd /var/home/nadya/a then /var/home/nadya2/b")).toBe(
      "cd ~/a then /var/home/nadya2/b",
    );
    expect(scrubber.counts.homePaths).toBe(1);
  });

  it("leaves ordinary text alone and counts nothing", () => {
    const scrubber = createDatasetScrubber({ homeDir: HOME });
    const text =
      "Use maxTokens: 4096 and the bearer token from settings. Commit 3f2a9c1d, see risk-assessment-v2.";
    expect(scrubber.scrub(text)).toBe(text);
    expect(totalRedactions(scrubber.counts)).toBe(0);
  });

  it("counts across calls and does not mask a marker twice", () => {
    const scrubber = createDatasetScrubber({ homeDir: HOME });
    const once = scrubber.scrub(`a ${OPENAI}`);
    scrubber.scrub(`b ${GITHUB} c@d.io`);
    expect(scrubber.scrub(once)).toBe(once);
    expect(scrubber.counts).toEqual({ secrets: 2, emails: 1, homePaths: 0 });
    expect(totalRedactions(scrubber.counts)).toBe(3);
  });
});
