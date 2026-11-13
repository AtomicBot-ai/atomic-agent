/**
 * The chat channels beyond Telegram and Discord (ATO-1169).
 *
 * Adding a messenger is one import and one entry here: the runtime
 * builds every listed adapter at boot (side-effect free), starts the
 * ones whose `channels.<id>.enabled` is true, lists them in
 * `runtime.channels` and stops them on shutdown. Nothing in bootstrap,
 * shutdown, the runtime contract or the config loader changes.
 *
 * Keep one entry per line so parallel adapter branches merge cleanly.
 */

import type { ChannelDefinition } from "./channel.js";

export const EXTRA_CHANNELS: readonly ChannelDefinition[] = [
];
