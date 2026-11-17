import { stat } from "node:fs/promises";
import { join } from "node:path";
import { appendSkillChange, type SkillChangeActor } from "./skill-change-log.js";
import { isCuratableSkillName, type SkillCuratorPaths } from "./skill-curator-config.js";
import { snapshotSkill } from "./skill-history.js";
import { SkillUsageLedger } from "./skill-usage-ledger.js";

export interface SkillChangeBefore {
  name: string;
  existed: boolean;
  snapshot: string | null;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The one object the runtime and the CLI use to keep the skill history:
 * count uses, snapshot a folder before a change, and log what the change
 * turned out to be once it is done (create, edit or delete).
 */
export class SkillChangeRecorder {
  readonly ledger: SkillUsageLedger;

  constructor(
    readonly skillsDir: string,
    readonly paths: SkillCuratorPaths,
    private readonly clock: () => number = Date.now,
  ) {
    this.ledger = new SkillUsageLedger(paths.usageFile);
  }

  recordUse(name: string): Promise<void> {
    if (!isCuratableSkillName(name)) return Promise.resolve();
    return this.ledger.recordUse(name, this.clock());
  }

  /** Call before something may change `<skillsDir>/<name>`. */
  async before(name: string): Promise<SkillChangeBefore> {
    const existed = await isDir(join(this.skillsDir, name));
    const snapshot = existed
      ? await snapshotSkill({ skillsDir: this.skillsDir, historyDir: this.paths.historyDir }, name, this.clock())
      : null;
    return { name, existed, snapshot };
  }

  /**
   * Call after the change. A folder the agent wrote into being is
   * recorded as agent-learned: the only kind the curator may archive.
   * `learned: false` (a move or a restore from the file tools) logs the
   * create without that claim, since the content came from somewhere else.
   */
  async after(
    before: SkillChangeBefore,
    actor: SkillChangeActor,
    tool?: string,
    options: { learned?: boolean } = {},
  ): Promise<void> {
    const exists = await isDir(join(this.skillsDir, before.name));
    const action = !before.existed ? (exists ? "create" : null) : exists ? "edit" : "delete";
    if (action === null) return;
    const now = this.clock();
    if (action === "create" && actor === "agent" && options.learned !== false) {
      await this.ledger.markAgentCreated(before.name, now);
    }
    await appendSkillChange(this.paths.changeLog, {
      at: now,
      name: before.name,
      action,
      actor,
      ...(before.snapshot ? { snapshot: before.snapshot } : {}),
      ...(tool ? { tool } : {}),
    });
  }
}
