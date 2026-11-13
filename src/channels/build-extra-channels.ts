/**
 * Build and register the adapters from `channel-catalog.ts` (ATO-1169).
 * Split from `runtime-channels.ts` so the policy (which ids exist, which
 * run on this platform, which start) is testable without a runtime.
 */

import { resolve } from "node:path";
import { createExtraChannelDefaults } from "../config/extra-channel-config.js";
import type { ChannelContext, ChannelDefinition } from "./channel.js";
import type { ChannelRegistry } from "./channel-registry.js";

export type ExtraChannelBuildContext = Omit<ChannelContext, "channelConfig" | "inboxDir">;

/**
 * Construct every definition that runs on `platform`, register it, and
 * return the ids that should start now (`channels.<id>.enabled`).
 * A definition that throws while constructing is logged and skipped:
 * one broken adapter must not take the runtime or the other channels down.
 */
export function buildExtraChannels(args: {
  definitions: readonly ChannelDefinition[];
  registry: ChannelRegistry;
  ctx: ExtraChannelBuildContext;
  platform?: NodeJS.Platform;
}): string[] {
  const { definitions, registry, ctx } = args;
  const platform = args.platform ?? process.platform;
  const toStart: string[] = [];
  for (const def of definitions) {
    if (def.platforms && !def.platforms.includes(platform)) continue;
    const channelConfig = ctx.config.channels?.[def.id] ?? createExtraChannelDefaults();
    try {
      const channel = def.create({
        ...ctx,
        channelConfig,
        inboxDir: resolve(ctx.stateDir, "inbox", def.id),
      });
      if (channel.id !== def.id) {
        throw new Error(`adapter built a channel with id "${channel.id}"`);
      }
      registry.register(channel);
    } catch (err) {
      ctx.logger.error(`${def.id}: could not build the channel`, {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (channelConfig.enabled) toStart.push(def.id);
  }
  return toStart;
}
