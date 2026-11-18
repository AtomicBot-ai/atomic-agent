import { describe, expect, it } from "vitest";
import { findSecretLikeStrings, LEARNED_SKILL_LIMITS, lintLearnedSkill } from "./skill-lint.js";

function skillMd(name: string, extra: { description?: string; frontmatter?: string; body?: string } = {}): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${extra.description ?? "Deploy the site to the staging bucket and check it answers."}`,
    "version: 1.0.0",
    ...(extra.frontmatter ? [extra.frontmatter] : []),
    "---",
    "",
    extra.body ?? "# Deploy\n\n1. Run `npm run build`.\n2. Run `aws s3 sync dist/ s3://staging`.\n3. Fetch the index page and check for a 200.\n",
  ].join("\n");
}

const none = new Set<string>();

describe("lintLearnedSkill", () => {
  it("accepts a small valid new skill", () => {
    expect(lintLearnedSkill({ content: skillMd("deploy-staging"), folderName: "deploy-staging", mode: "create", takenNames: none }))
      .toEqual({ ok: true, issues: [] });
  });

  it("refuses a file without frontmatter", () => {
    const result = lintLearnedSkill({ content: "# deploy\n\nsteps", folderName: "deploy", mode: "create", takenNames: none });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/frontmatter/);
  });

  it("requires name and description", () => {
    const content = "---\nversion: 1.0.0\n---\n\nA body that is long enough to count as a body of a skill.\n";
    const result = lintLearnedSkill({ content, folderName: "x-skill", mode: "create", takenNames: none });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("`name` is required"))).toBe(true);
    expect(result.issues.some((i) => i.includes("`description` is required"))).toBe(true);
  });

  it("requires the frontmatter name to equal the folder", () => {
    const result = lintLearnedSkill({ content: skillMd("deploy-prod"), folderName: "deploy-staging", mode: "create", takenNames: none });
    expect(result.issues.join(" ")).toMatch(/must equal the folder name/);
  });

  it("refuses a name that is not kebab-case", () => {
    const result = lintLearnedSkill({ content: skillMd("Deploy_Staging"), folderName: "Deploy_Staging", mode: "create", takenNames: none });
    expect(result.ok).toBe(false);
  });

  it("refuses a new skill whose name is taken, and a patch of a name that is not", () => {
    const taken = new Set(["deploy-staging"]);
    expect(lintLearnedSkill({ content: skillMd("deploy-staging"), folderName: "deploy-staging", mode: "create", takenNames: taken }).issues.join(" "))
      .toMatch(/already exists/);
    expect(lintLearnedSkill({ content: skillMd("deploy-staging"), folderName: "deploy-staging", mode: "patch", takenNames: taken }).ok).toBe(true);
    expect(lintLearnedSkill({ content: skillMd("other-skill"), folderName: "other-skill", mode: "patch", takenNames: taken }).issues.join(" "))
      .toMatch(/no skill named other-skill/);
  });

  it("caps the size", () => {
    const body = `# big\n\n${"1. step that repeats itself\n".repeat(700)}`;
    const result = lintLearnedSkill({ content: skillMd("big-skill", { body }), folderName: "big-skill", mode: "create", takenNames: none });
    expect(Buffer.byteLength(skillMd("big-skill", { body }))).toBeGreaterThan(LEARNED_SKILL_LIMITS.maxBytes);
    expect(result.issues.join(" ")).toMatch(/at most 16384/);
  });

  it("refuses an empty body and an overlong description", () => {
    const result = lintLearnedSkill({
      content: skillMd("thin-skill", { body: "# thin\n", description: "x".repeat(400) }),
      folderName: "thin-skill",
      mode: "create",
      takenNames: none,
    });
    expect(result.issues.join(" ")).toMatch(/too short/);
    expect(result.issues.join(" ")).toMatch(/description is 400 characters/);
  });

  it("refuses scripts, env keys and the dangerous flag", () => {
    const result = lintLearnedSkill({
      content: skillMd("scripted", { frontmatter: "requires_scripts: [run.sh]\nenv_keys: [SOME_API_KEY]\ndangerous: true" }),
      folderName: "scripted",
      mode: "create",
      takenNames: none,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      "a learned skill may not declare requires_scripts",
      "a learned skill may not be marked dangerous",
      "a learned skill may not declare env_keys",
    ]));
  });

  it("refuses anything that looks like a secret", () => {
    const body = "# api\n\n1. Call the API with header `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`.\n";
    const result = lintLearnedSkill({ content: skillMd("call-api", { body }), folderName: "call-api", mode: "create", takenNames: none });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/secret/);
  });
});

describe("findSecretLikeStrings", () => {
  it("finds common key shapes", () => {
    expect(findSecretLikeStrings("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx")).not.toEqual([]);
    expect(findSecretLikeStrings("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("GitHub token");
    expect(findSecretLikeStrings("AKIAABCDEFGHIJKLMNOP")).toContain("AWS access key");
    expect(findSecretLikeStrings("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private key block");
    expect(findSecretLikeStrings('password: "hunter2hunter2hunter2"')).toContain("inline secret assignment");
  });

  it("leaves placeholders and ordinary text alone", () => {
    expect(findSecretLikeStrings("api_key: ${OPENAI_API_KEY}")).toEqual([]);
    expect(findSecretLikeStrings("token: <your token here>")).toEqual([]);
    expect(findSecretLikeStrings("Run `gh auth status` and check the token scopes.")).toEqual([]);
  });
});
