import type { ConfigLeaf } from "./config-paths.js";
import { envOverrideFor, type EnvSetting } from "./env-settings.js";

/**
 * The list of every user setting with its type, default and description
 * (ATO-41): what `atomic-agent config list --describe|--json`, the TUI's
 * `/settings` and the desktop's "All settings" view show, and what
 * `docs/user/settings-reference.md` is generated from.
 *
 * The keys and defaults come from `USER_CONFIG_DEFAULTS` (through
 * `listConfigLeaves`), the types and descriptions from the JSDoc on
 * `UserConfigFile` (through the generated `settings-docs.generated.ts`),
 * the env overrides from `env-settings.ts`. Nothing here is a second
 * list of keys: a key added to the schema shows up on the next
 * regeneration, and the reference test fails until it is regenerated.
 */

/** Type and description of one key, as extracted from the schema's JSDoc. */
export interface SettingDoc {
  /** The declared TypeScript type, e.g. `number` or `'auto' | 'on' | 'off'`. */
  readonly type: string;
  /** First paragraph of the key's JSDoc; empty when the key has none. */
  readonly description: string;
}

/** One row of the reference. */
export interface SettingEntry {
  /** Dotted key, as `config get|set` spells it. */
  readonly key: string;
  readonly type: string;
  readonly default: unknown;
  readonly description: string;
  /** Env variable that wins over this key when set, or null. */
  readonly envVar: string | null;
  /**
   * True when `atomic-agent config set <key> <value>` can write it:
   * not a list (those need the whole-file JSON form) and not `version`.
   */
  readonly settable: boolean;
}

const READ_ONLY = new Set(["version"]);

/** Fallback type when the schema walk found no declared type. */
function typeOfDefault(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Pure: join leaves, extracted docs and the env table into reference rows. */
export function buildSettingsReference(
  leaves: readonly ConfigLeaf[],
  docs: Readonly<Record<string, SettingDoc>>,
  envSettings: readonly EnvSetting[],
): SettingEntry[] {
  return leaves.map((leaf) => {
    const doc = docs[leaf.key];
    return {
      key: leaf.key,
      type: doc?.type ?? typeOfDefault(leaf.defaultValue),
      default: leaf.defaultValue,
      description: doc?.description ?? "",
      envVar: envOverrideFor(leaf.key, envSettings),
      settable: !leaf.isArray && !READ_ONLY.has(leaf.key),
    };
  });
}

/**
 * Rows whose key, description or env variable contains every word of
 * `query` (case-insensitive). An empty query keeps every row.
 */
export function filterSettings(entries: readonly SettingEntry[], query: string): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.key} ${entry.description} ${entry.envVar ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** `JSON.stringify` of a default, with `undefined` spelled out. */
export function formatSettingValue(value: unknown): string {
  return value === undefined ? "unset" : JSON.stringify(value);
}

/**
 * Plain-text listing for the terminal: one `key = default  (type)` line
 * per setting, the description indented under it. `values`, when given,
 * maps a key to its rendered current value, shown when it differs from
 * the default.
 */
export function renderSettingsText(
  entries: readonly SettingEntry[],
  values?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const shownDefault = formatSettingValue(entry.default);
    const current = values?.get(entry.key);
    const head = current !== undefined && current !== shownDefault
      ? `${entry.key} = ${current}  (default ${shownDefault})`
      : `${entry.key} = ${shownDefault}`;
    lines.push(`${head}  [${entry.type}]`);
    if (entry.description) lines.push(`    ${entry.description}`);
    if (entry.envVar) lines.push(`    env ${entry.envVar} wins when set`);
    if (!entry.settable && entry.key !== "version") lines.push("    list: set it with the whole-file JSON form");
  }
  return lines.join("\n");
}

/** Plain-text table of the env variables, for `atomic-agent config env`. */
export function renderEnvSettingsText(envSettings: readonly EnvSetting[]): string {
  return envSettings
    .map((setting) => {
      const head = `${setting.name}${setting.default === null ? "" : ` (default ${formatSettingValue(setting.default)})`}`;
      const scope = setting.overrides ? `    overrides config ${setting.overrides}` : "    env only";
      return `${head}\n    ${setting.description}\n${scope}`;
    })
    .join("\n");
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mdCode(text: string): string {
  // A cell value with a backtick would end the code span early.
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** Top-level block of a key, e.g. `localModels` for `localModels.managed.port`. */
function blockOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * The whole of `docs/user/settings-reference.md`. Generated; the test
 * compares it with the checked-in file, so it must be deterministic.
 */
export function renderSettingsReferenceMarkdown(
  entries: readonly SettingEntry[],
  envSettings: readonly EnvSetting[],
  configVersion: number,
): string {
  const out: string[] = [
    "# Settings reference",
    "",
    "Status: generated",
    "Owner: src/config/",
    "",
    "<!-- GENERATED by scripts/gen-settings-reference.ts. Do not edit by hand. -->",
    "",
    `Every setting in \`~/.atomic-agent/config.json\` (config version ${configVersion}), with its type, default and description, followed by the settings that only exist as environment variables. Defaults are what a fresh install gets; migrations and env variables can make an existing install differ.`,
    "",
    "Read or change a setting from the terminal:",
    "",
    "```sh",
    "atomic-agent config list --describe      # this list, with your current values",
    "atomic-agent config get agent.maxSteps",
    "atomic-agent config set agent.maxSteps 40",
    "atomic-agent config unset agent.maxSteps # back to the default",
    "```",
    "",
    "In the TUI, `/settings <words>` searches the same list. The desktop app shows it under Settings, Advanced, All settings. List-valued keys have no single-value form; set them with the whole-file JSON form (`atomic-agent config set -`).",
    "",
  ];
  let block: string | null = null;
  entries.forEach((entry, index) => {
    const next = blockOf(entry.key);
    if (next !== block) {
      block = next;
      out.push(`## ${block}`, "", "| Key | Type | Default | Description |", "| --- | --- | --- | --- |");
    }
    const notes = [
      entry.description,
      entry.envVar ? `Env \`${entry.envVar}\` wins when set.` : "",
    ].filter((part) => part.length > 0).join(" ");
    out.push(
      `| ${mdCode(entry.key)} | ${mdCell(mdCode(entry.type))} | ${mdCell(mdCode(formatSettingValue(entry.default)))} | ${mdCell(notes)} |`,
    );
    const following = entries[index + 1];
    if (!following || blockOf(following.key) !== block) out.push("");
  });
  out.push(
    "## Environment variables",
    "",
    "Read from the process environment or from `~/.atomic-agent/.env` (a variable already set in the environment wins over the file). \"Overrides\" names the config key a variable wins over; the rest exist only as environment variables. `atomic-agent config env` prints this table.",
    "",
    "| Variable | Default | Overrides | Description |",
    "| --- | --- | --- | --- |",
  );
  for (const setting of envSettings) {
    const shown = setting.default === null ? "unset" : mdCode(formatSettingValue(setting.default));
    const overrides = setting.overrides ? mdCode(setting.overrides) : "env only";
    out.push(`| ${mdCode(setting.name)} | ${mdCell(shown)} | ${overrides} | ${mdCell(setting.description)} |`);
  }
  out.push(
    "",
    "Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the rest) are also read from the environment or `.env`; the provider settings in the TUI and the desktop app write them for you.",
    "",
  );
  return out.join("\n");
}
