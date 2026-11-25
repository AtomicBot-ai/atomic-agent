import { GithubSkillClient, type SkillHubClient } from "./github-skill-client.js";
import {
  SkillHubInstallError,
  stageSkillFromHub,
  type StagedSkillInstall,
} from "./install-from-hub.js";
import { formatSkillIdentifier, parseSkillIdentifier, type SkillIdentifier } from "./skill-hub-source.js";
import { SKILLS_SH_PREFIX } from "./skills-sh-client.js";

/**
 * Install side of skills.sh. A row names `owner/repo` and a skill folder
 * name, not the folder's path in the repo (`anthropics/skills` keeps
 * `pdf` under `skills/pdf`), so the path is looked up in the repo tree
 * first. The download, the security scan and the gate are the GitHub
 * tap's own: skills.sh content gets no shortcut.
 */

/**
 * Turn `skills.sh/owner/repo/skillId[@ref]` into a GitHub identifier
 * `owner/repo/<dir>@<ref>`, pinned to the ref the tree was read at.
 */
export async function resolveSkillsShIdentifier(
  identifier: string,
  client: SkillHubClient,
): Promise<string> {
  const trimmed = identifier.trim();
  if (!trimmed.startsWith(SKILLS_SH_PREFIX)) {
    throw new SkillHubInstallError(`not a skills.sh identifier: ${identifier}`, "invalid_identifier");
  }
  let id: SkillIdentifier;
  try {
    id = parseSkillIdentifier(trimmed.slice(SKILLS_SH_PREFIX.length));
  } catch (err) {
    throw new SkillHubInstallError(err instanceof Error ? err.message : String(err), "invalid_identifier");
  }
  if (id.path.length === 0 || id.path.includes("/")) {
    throw new SkillHubInstallError(`expected skills.sh/owner/repo/skill, got: ${identifier}`, "invalid_identifier");
  }
  const ref = id.ref ?? (await client.resolveDefaultBranch(id.owner, id.repo));
  const manifests = await client.listSkillManifests(id.owner, id.repo, ref);
  const dirs = manifests.map((m) => m.dir);
  const skillId = id.path;
  let dir: string | undefined = dirs.find((d) => d === skillId);
  if (dir === undefined) {
    const byLeaf = dirs.filter((d) => d.split("/").pop() === skillId);
    if (byLeaf.length > 1) {
      const options = byLeaf.map((d) => formatSkillIdentifier(id.owner, id.repo, d)).join(", ");
      throw new SkillHubInstallError(`${identifier} matches several skills; install one of: ${options}`, "invalid_identifier");
    }
    dir = byLeaf[0];
  }
  // A repository that is one skill keeps SKILL.md at its root.
  if (dir === undefined && dirs.length === 1 && dirs[0] === "") dir = "";
  if (dir === undefined) {
    throw new SkillHubInstallError(`SKILL.md for ${skillId} not found in ${id.owner}/${id.repo}`, "manifest_missing");
  }
  return `${formatSkillIdentifier(id.owner, id.repo, dir)}@${ref}`;
}

export interface StageSkillsShOptions {
  identifier: string;
  client?: SkillHubClient;
  tmpRoot?: string;
}

/** Resolve a skills.sh row to its GitHub folder, then stage it like any tap skill. */
export async function stageSkillFromSkillsSh(options: StageSkillsShOptions): Promise<StagedSkillInstall> {
  const client = options.client ?? new GithubSkillClient();
  const resolved = await resolveSkillsShIdentifier(options.identifier, client);
  return stageSkillFromHub({ identifier: resolved, client, ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}) });
}
