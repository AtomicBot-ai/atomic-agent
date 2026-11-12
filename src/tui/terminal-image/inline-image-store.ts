import { readFileSync, statSync } from "node:fs";
import { registerTerminalRestore } from "../terminal-restore.js";
import { resolveImageProtocol, type ImageProtocol } from "./detect-image-protocol.js";
import { fitImageCells, MAX_IMAGE_COLS, MAX_IMAGE_ROWS, type CellBox } from "./fit-image-cells.js";
import { readImageInfo } from "./image-header.js";
import { encodeKittyDelete, encodeKittyTransmit } from "./kitty-graphics.js";

/** Bigger files keep the path-only card: base64 of 5 MB is already ~7 MB of escape. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** `image.generate` makes at most 4; anything past that stays a path. */
export const MAX_INLINE_IMAGES_PER_CARD = 4;
const GAP_COLS = 1;

/** A picture ready to show: its kitty id and the cells it takes. */
export interface InlineImage {
  readonly path: string;
  readonly id: number;
  readonly cols: number;
  readonly rows: number;
}

interface Entry {
  readonly image: InlineImage | null;
  /** The bytes until they are sent once; then dropped. */
  pending: Uint8Array | null;
}

export interface InlineImageStoreOptions {
  readonly readFile?: (path: string) => Uint8Array;
  readonly fileSize?: (path: string) => number;
  readonly firstId?: number;
}

export interface InlineImageStore {
  /** Loads (once) and sizes a PNG within `box`; `null` for anything we will not show. */
  load(path: string, box: CellBox): InlineImage | null;
  /** The transmit escape the first time it is asked for, `null` after. */
  takeTransmit(path: string): string | null;
  /** Delete escapes for every picture already sent. */
  deleteAllSequence(): string;
}

export function createInlineImageStore(options: InlineImageStoreOptions = {}): InlineImageStore {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const fileSize = options.fileSize ?? ((path: string) => statSync(path).size);
  const cache = new Map<string, Entry>();
  const sent: number[] = [];
  let nextId = options.firstId ?? 1 + ((process.pid * 7919) % 0xf00000);

  function readEntry(path: string, box: CellBox): Entry {
    try {
      const size = fileSize(path);
      if (!(size > 0) || size > MAX_INLINE_IMAGE_BYTES) return { image: null, pending: null };
      const bytes = readFile(path);
      const info = readImageInfo(bytes);
      // The kitty transmit uses f=100, which is PNG only; decoding JPEG
      // or GIF would need an image library.
      if (info === null || info.type !== "png") return { image: null, pending: null };
      const cells = fitImageCells(info.width, info.height, box);
      const id = nextId;
      nextId = nextId >= 0xffffff ? 1 : nextId + 1;
      return { image: { path, id, ...cells }, pending: bytes };
    } catch {
      return { image: null, pending: null };
    }
  }

  return {
    load(path, box) {
      let entry = cache.get(path);
      if (entry === undefined) {
        entry = readEntry(path, box);
        cache.set(path, entry);
      }
      return entry.image;
    },
    takeTransmit(path) {
      const entry = cache.get(path);
      if (!entry?.image || entry.pending === null) return null;
      const { id, cols, rows } = entry.image;
      const sequence = encodeKittyTransmit(entry.pending, id, cols, rows);
      entry.pending = null;
      sent.push(id);
      return sequence;
    },
    deleteAllSequence() {
      return sent.map((id) => encodeKittyDelete(id)).join("");
    },
  };
}

/** The image files a finished `image.generate` card saved, in order. */
export function toolCardImagePaths(card: {
  readonly tool: string;
  readonly status?: string;
  readonly details?: Record<string, unknown>;
}): string[] {
  if (card.tool !== "image.generate" || card.status !== "ok") return [];
  const raw = card.details?.["paths"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .slice(0, MAX_INLINE_IMAGES_PER_CARD);
}

/** The per-picture box when `count` pictures share one row of the card. */
export function imageBoxFor(count: number): CellBox {
  const n = Math.max(1, count);
  return {
    cols: Math.max(1, Math.floor((MAX_IMAGE_COLS - GAP_COLS * (n - 1)) / n)),
    rows: MAX_IMAGE_ROWS,
  };
}

/** The pictures a card shows inline; empty when the protocol is off. */
export function toolCardInlineImages(
  card: Parameters<typeof toolCardImagePaths>[0],
  protocol: ImageProtocol | null,
  store: InlineImageStore,
): InlineImage[] {
  if (protocol !== "kitty") return [];
  const paths = toolCardImagePaths(card);
  const box = imageBoxFor(paths.length);
  return paths.map((p) => store.load(p, box)).filter((i): i is InlineImage => i !== null);
}

/** Rows the card's picture strip adds; what `estimateToolCardHeight` charges. */
export function inlineImageRows(images: readonly InlineImage[]): number {
  return images.reduce((max, image) => Math.max(max, image.rows), 0);
}

let defaultProtocol: ImageProtocol | null | undefined;
let defaultStore: InlineImageStore | undefined;

/** Read once from `process.env`. */
export function getDefaultImageProtocol(): ImageProtocol | null {
  if (defaultProtocol === undefined) defaultProtocol = resolveImageProtocol(process.env);
  return defaultProtocol;
}

/** The process-wide store; frees what it sent when the terminal is restored. */
export function getDefaultInlineImageStore(): InlineImageStore {
  if (defaultStore === undefined) {
    const store = createInlineImageStore();
    defaultStore = store;
    registerTerminalRestore(() => {
      const sequence = store.deleteAllSequence();
      if (sequence.length > 0 && process.stdout.isTTY) process.stdout.write(sequence);
    });
  }
  return defaultStore;
}

/** Rows the default protocol and store add under `card`; 0 while the feature is off. */
export function estimateToolCardImageRows(card: Parameters<typeof toolCardImagePaths>[0]): number {
  const protocol = getDefaultImageProtocol();
  if (protocol !== "kitty") return 0;
  return inlineImageRows(toolCardInlineImages(card, protocol, getDefaultInlineImageStore()));
}
