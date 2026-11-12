/**
 * ATO-272 / ATO-1026 item 8: runs on a CI server (GitHub Actions, GitLab
 * CI, a Jenkins job, ...) are tagged so PostHog can tell them apart from a
 * person at a keyboard.
 *
 * Tag, not drop: the counting rule decided on 12.10.2026 leaves out only our
 * own machines and test runs (ATOMIC_AGENT_TEAM, ATOMIC_AGENT_ANALYTICS=off);
 * other people's scheduled scripts and CI jobs are real use of the product
 * and stay in the numbers. The tag lets a dashboard split them when needed.
 *
 * Only the fact "this is CI" is sent, as `automation: true`. The name of the
 * CI system, job ids and other values of these variables never leave the
 * machine.
 */

/**
 * Variables CI systems set on every job. Any of them present and not
 * explicitly false marks the run as automated. `CI` covers most systems
 * (GitHub Actions, GitLab, CircleCI, Travis, Buildkite, Bitbucket, Drone,
 * Vercel, Netlify...); the rest cover systems that do not set it.
 */
export const CI_ENV_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "DRONE",
] as const;

/** Values that mean "not CI" even though the variable is set (e.g. `CI=false`). */
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

/** True when one of the well-known CI variables says this process runs on CI. */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const name of CI_ENV_VARS) {
    const raw = env[name];
    if (typeof raw !== "string") continue;
    if (!FALSE_VALUES.has(raw.trim().toLowerCase())) return true;
  }
  return false;
}
