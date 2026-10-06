import { describe, expect, it } from "vitest";
import {
  createDiscordDefaults, createSwarmDefaults, createTelegramDefaults,
  parseDiscordConfig, parseDiscordOwnerUserIds, parseSwarmConfig,
  parseTelegramConfig, parseTelegramOwnerId, SWARM_UNIT_ID,
} from "./channel-config.js";
import * as schema from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";

const FIRST_OWNER = "123456789012345";
const SECOND_OWNER = "9999999999999999999999999";
const UNIT = { id: "synthetic-unit", kind: "telegram", label: "Synthetic", tokenEnv: "SYNTHETIC_BOT_TOKEN" };

function thrownError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected channel configuration fixture validation to reject");
}

describe("channel configuration ownership and compatibility", () => {
  it("keeps public functions, regex and the existing validation-error identity", () => {
    expect(schema.parseTelegramOwnerId).toBe(parseTelegramOwnerId);
    expect(schema.parseDiscordOwnerUserIds).toBe(parseDiscordOwnerUserIds);
    expect(schema.SWARM_UNIT_ID).toBe(SWARM_UNIT_ID);
    expect(schema.ConfigValidationError).toBe(ConfigValidationError);
  });

  it("constructs fresh mutable defaults and output arrays with the original key order", () => {
    const telegram = createTelegramDefaults();
    const discord = createDiscordDefaults();
    const swarm = createSwarmDefaults();
    expect(telegram).toStrictEqual({ enabled: false, ownerUserId: null, parseMode: "html", progressIndicator: true });
    expect(discord).toStrictEqual({ enabled: false, ownerUserIds: [] });
    expect(swarm).toStrictEqual({ units: [] });
    expect(Object.keys(telegram)).toEqual(["enabled", "ownerUserId", "parseMode", "progressIndicator"]);
    expect(discord.ownerUserIds).not.toBe(createDiscordDefaults().ownerUserIds);
    expect(swarm.units).not.toBe(createSwarmDefaults().units);
    telegram.enabled = true;
    discord.ownerUserIds.push(FIRST_OWNER);
    swarm.units.push(...parseSwarmConfig({ units: [UNIT] }).units);
    expect(createTelegramDefaults().enabled).toBe(false);
    expect(createDiscordDefaults().ownerUserIds).toEqual([]);
    expect(createSwarmDefaults().units).toEqual([]);
    expect(parseDiscordConfig({}, createDiscordDefaults).ownerUserIds).not.toBe(parseDiscordConfig({}, createDiscordDefaults).ownerUserIds);
    expect(parseSwarmConfig({}).units).not.toBe(parseSwarmConfig({}).units);
  });

  it.each([
    { raw: " 12 ", expected: 12 }, { raw: "1e3", expected: 1000 },
    { raw: "0x10", expected: 16 }, { raw: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
    { raw: null, expected: null }, { raw: undefined, expected: null },
  ])("retains Telegram Number conversion for $raw", ({ raw, expected }) => {
    expect(parseTelegramOwnerId(raw, "synthetic.owner")).toBe(expected);
    expect(parseTelegramConfig({ ownerUserId: raw }, createTelegramDefaults).ownerUserId).toBe(expected);
    expect(schema.parseUserConfigFile({ telegram: { ownerUserId: raw } }).telegram.ownerUserId).toBe(expected);
  });

  it.each(["", " ", 0, true, "9007199254740993"])("rejects invalid Telegram owner %j even while disabled", (raw) => {
    const reason = `expected positive integer or null, got ${JSON.stringify(raw)}`;
    for (const error of [thrownError(() => parseTelegramConfig({ enabled: false, ownerUserId: raw }, createTelegramDefaults)), thrownError(() => schema.parseUserConfigFile({ telegram: { enabled: false, ownerUserId: raw } }))]) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ field: "telegram.ownerUserId", reason });
    }
  });

  it("uses Discord list presence instead of config version, ignoring legacy only for a present list", () => {
    const events: string[] = [];
    const present = { ownerUserIds: [], get ownerUserId() { events.push("legacy"); throw new Error("legacy must be ignored"); } };
    expect(parseDiscordOwnerUserIds(present)).toEqual([]);
    expect(events).toEqual([]);
    expect(parseDiscordOwnerUserIds({ ownerUserIds: null, ownerUserId: ` ${FIRST_OWNER} ` })).toEqual([FIRST_OWNER]);
    expect(parseDiscordOwnerUserIds({ ownerUserId: " " })).toEqual([]);
    expect(parseDiscordOwnerUserIds({ ownerUserIds: [SECOND_OWNER, FIRST_OWNER, SECOND_OWNER, FIRST_OWNER] }))
      .toEqual([SECOND_OWNER, FIRST_OWNER]);
    for (const version of [51, 52, 74]) {
      expect(schema.parseUserConfigFile({ version, discord: { ownerUserIds: [], ownerUserId: "invalid ignored legacy" } }).discord.ownerUserIds).toEqual([]);
      expect(schema.parseUserConfigFile({ version, discord: { ownerUserIds: null, ownerUserId: ` ${FIRST_OWNER} ` } }).discord.ownerUserIds).toEqual([FIRST_OWNER]);
    }
  });

  it.each([
    { raw: { ownerUserIds: [Number(FIRST_OWNER)] }, field: "discord.ownerUserIds[0]", value: Number(FIRST_OWNER) },
    { raw: { ownerUserIds: [` ${FIRST_OWNER} `] }, field: "discord.ownerUserIds[0]", value: ` ${FIRST_OWNER} ` },
    { raw: { ownerUserId: "123" }, field: "discord.ownerUserId", value: "123" },
  ])("preserves Discord owner errors at $field", ({ raw, field, value }) => {
    const reason = `expected a 15-25 digit Discord user id, got ${JSON.stringify(value)}`;
    for (const error of [thrownError(() => parseDiscordConfig(raw, createDiscordDefaults)), thrownError(() => schema.parseUserConfigFile({ discord: raw }))]) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it("keeps swarm shape/bounds and trim behavior without kind-specific owner policy", () => {
    const units = [{ ...UNIT, label: "x".repeat(40), role: "x".repeat(120), ownerUserId: " 0 " },
      { ...UNIT, id: "other-unit", kind: "discord", tokenEnv: "DISCORD_BOT_TOKEN", role: null, ownerUserId: " 1 " }];
    const parsed = parseSwarmConfig({ units });
    expect(schema.parseUserConfigFile({ swarm: { units } }).swarm).toStrictEqual(parsed);
    expect(parsed.units[0]?.ownerUserId).toBe("0");
    expect(parsed.units[1]?.ownerUserId).toBe("1");
    expect(parsed.units[1]?.role).toBe("");
    expect(parsed.units[0]?.enabled).toBe(false);
    expect(Object.keys(parsed.units[0] ?? {})).toEqual(["id", "kind", "label", "role", "enabled", "tokenEnv", "ownerUserId"]);
  });

  it.each([
    { units: [{ ...UNIT, ownerUserId: "invalid", enabled: "also invalid" }], field: "swarm.units[0].ownerUserId", reason: "must be a numeric user id" },
    { units: [UNIT, { ...UNIT, tokenEnv: "OTHER_TOKEN" }], field: "swarm.units[1].id", reason: "duplicate id 'synthetic-unit'" },
    { units: [UNIT, { ...UNIT, id: "other-unit" }], field: "swarm.units[1].tokenEnv", reason: "duplicate token env 'SYNTHETIC_BOT_TOKEN'" },
    { units: [{ ...UNIT, label: "x".repeat(41), enabled: false }], field: "swarm.units[0].label", reason: "must be at most 40 characters" },
    { units: [{ ...UNIT, role: "x".repeat(121), enabled: false }], field: "swarm.units[0].role", reason: "must be a string of at most 120 characters" },
    { units: [{ ...UNIT, ownerUserId: "1".repeat(26) }], field: "swarm.units[0].ownerUserId", reason: "must be a numeric user id" },
  ])("preserves swarm validation order at $field", ({ units, field, reason }) => {
    for (const error of [thrownError(() => parseSwarmConfig({ units })), thrownError(() => schema.parseUserConfigFile({ swarm: { units } }))]) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it.each([
    { kind: "telegram", role: undefined, kindReads: 2, roleReads: 1 },
    { kind: "discord", role: null, kindReads: 3, roleReads: 2 },
    { kind: "discord", role: " synthetic role ", kindReads: 3, roleReads: 3 },
  ])("retains repeated swarm getters for $kind / $role", ({ kind, role, kindReads, roleReads }) => {
    let kinds = 0;
    let roles = 0;
    const unit = { ...UNIT, get kind() { kinds += 1; return kind; }, get role() { roles += 1; return role; } };
    expect(parseSwarmConfig({ units: [unit] }).units[0]?.kind).toBe(kind);
    expect(kinds).toBe(kindReads);
    expect(roles).toBe(roleReads);
  });

  it("preserves sparse swarm holes and fresh arrays for absent/null inputs", () => {
    const sparse = new Array<unknown>(3);
    sparse[2] = UNIT;
    const direct = parseSwarmConfig({ units: sparse }).units;
    const root = schema.parseUserConfigFile({ swarm: { units: sparse } }).swarm.units;
    expect(direct.length).toBe(3);
    expect(0 in direct).toBe(false);
    expect(1 in direct).toBe(false);
    expect(direct[2]?.id).toBe(UNIT.id);
    expect(root).toStrictEqual(direct);
    expect(direct).not.toBe(sparse);
    expect(parseSwarmConfig({ units: null }).units).toEqual([]);
    expect(parseSwarmConfig({ units: null }).units).not.toBe(parseSwarmConfig({ units: null }).units);
  });

  it("short-circuits channel defaults for explicit scalars", () => {
    const noDefaults = () => { throw new Error("explicit scalar defaults must not be read"); };
    const telegram = { enabled: false, ownerUserId: 12, parseMode: "plain", progressIndicator: false };
    expect(parseTelegramConfig(telegram, noDefaults)).toStrictEqual(telegram);
    expect(parseDiscordConfig({ enabled: false, ownerUserIds: [] }, noDefaults))
      .toStrictEqual({ enabled: false, ownerUserIds: [] });
  });

  it("reads current per-expression defaults and ignores mutable Discord/swarm default lists", () => {
    const originalTelegram = schema.USER_CONFIG_DEFAULTS.telegram;
    const originalDiscord = schema.USER_CONFIG_DEFAULTS.discord;
    const originalSwarm = schema.USER_CONFIG_DEFAULTS.swarm;
    const events: string[] = [];
    try {
      schema.USER_CONFIG_DEFAULTS.telegram = createTelegramDefaults();
      schema.USER_CONFIG_DEFAULTS.discord = { enabled: true, ownerUserIds: [FIRST_OWNER] };
      schema.USER_CONFIG_DEFAULTS.swarm = parseSwarmConfig({ units: [UNIT] });
      const root = schema.parseUserConfigFile({ telegram: {
        get enabled() { events.push("enabled"); schema.USER_CONFIG_DEFAULTS.telegram = { ...createTelegramDefaults(), enabled: true, ownerUserId: 12 }; return undefined; },
        get ownerUserId() { events.push("owner"); schema.USER_CONFIG_DEFAULTS.telegram = { enabled: false, ownerUserId: 34, parseMode: "plain", progressIndicator: false }; return null; },
      } });
      expect(events).toEqual(["enabled", "owner"]);
      expect(root.telegram).toStrictEqual({ enabled: true, ownerUserId: 34, parseMode: "plain", progressIndicator: false });
      expect(root.discord).toStrictEqual({ enabled: true, ownerUserIds: [] });
      expect(root.swarm.units).toEqual([]);
      schema.USER_CONFIG_DEFAULTS.telegram.ownerUserId = 56;
      expect(root.telegram.ownerUserId).toBe(34);
      expect(root.telegram).not.toBe(schema.USER_CONFIG_DEFAULTS.telegram);
    } finally {
      schema.USER_CONFIG_DEFAULTS.telegram = originalTelegram;
      schema.USER_CONFIG_DEFAULTS.discord = originalDiscord;
      schema.USER_CONFIG_DEFAULTS.swarm = originalSwarm;
    }
  });
});
