/**
 * Read-only parser for the Compound File Binary format (MS-CFB, "OLE2"),
 * the container behind Outlook `.msg` files. Small on purpose: header,
 * FAT (with the DIFAT chain), directory, mini FAT and mini stream, and
 * nothing that writes.
 *
 * Every offset and size comes from the file, so every one is checked
 * against the buffer. Sector chains are walked with a hard step limit (a
 * chain can never be longer than the file has sectors), so a looping or
 * corrupt chain ends in a `CfbError` instead of a hang, and a stream is
 * only allocated after its claimed size has been checked against the
 * sectors that actually exist.
 */

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfbError";
  }
}

export interface CfbEntry {
  index: number;
  name: string;
  type: "storage" | "stream" | "root" | "unknown";
  /** First sector of the stream (FAT or mini FAT sector id). */
  start: number;
  size: number;
  /** Children of a storage, keyed by upper-cased name. */
  children: Map<string, number>;
}

export interface CfbFile {
  root: CfbEntry;
  entry(index: number): CfbEntry;
  /** Child of a storage by name, case-insensitive (as MS-CFB compares). */
  child(storage: CfbEntry, name: string): CfbEntry | undefined;
  /** Read a stream's bytes. Throws `CfbError` on a broken chain. */
  read(stream: CfbEntry): Buffer;
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAXREGSECT = 0xfffffffa;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;
const HEADER_DIFAT_ENTRIES = 109;
const DIR_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;

export function isCfb(data: Uint8Array): boolean {
  return data.length >= 8 && SIGNATURE.every((b, i) => data[i] === b);
}

export function openCfb(data: Buffer): CfbFile {
  if (data.length < 512) {
    throw new CfbError("file is too short to be an OLE2 compound file");
  }
  if (!isCfb(data)) {
    throw new CfbError("not an OLE2 compound file (bad signature)");
  }
  const majorVersion = data.readUInt16LE(0x1a);
  const sectorShift = data.readUInt16LE(0x1e);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new CfbError(`unsupported sector size 2^${sectorShift}`);
  }
  if (data.readUInt16LE(0x20) !== 6) {
    throw new CfbError("unsupported mini sector size");
  }
  const sectorSize = 1 << sectorShift;
  // Sector n lives at (n + 1) * sectorSize: the header occupies "sector -1".
  // A partial last sector still counts; reads clamp to the buffer.
  const sectorCount =
    data.length > sectorSize ? Math.ceil((data.length - sectorSize) / sectorSize) : 0;
  const miniCutoff = data.readUInt32LE(0x38);

  const sector = (id: number): Buffer => {
    if (id > MAXREGSECT || id >= sectorCount) {
      throw new CfbError(`sector ${id} is outside the file (truncated?)`);
    }
    const start = (id + 1) * sectorSize;
    return data.subarray(start, Math.min(start + sectorSize, data.length));
  };

  // ---- FAT sector list: 109 ids in the header, the rest in the DIFAT chain.
  const fatSectorCount = data.readUInt32LE(0x2c);
  if (fatSectorCount > sectorCount) {
    throw new CfbError("FAT is larger than the file (truncated?)");
  }
  const fatIds: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES && fatIds.length < fatSectorCount; i++) {
    const id = data.readUInt32LE(0x4c + i * 4);
    if (id > MAXREGSECT) break;
    fatIds.push(id);
  }
  let difat = data.readUInt32LE(0x44);
  let difatSteps = 0;
  while (fatIds.length < fatSectorCount && difat <= MAXREGSECT) {
    if (++difatSteps > sectorCount) throw new CfbError("DIFAT chain loops");
    const bytes = sector(difat);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector && fatIds.length < fatSectorCount; i++) {
      if (i * 4 + 4 > bytes.length) break;
      const id = bytes.readUInt32LE(i * 4);
      if (id <= MAXREGSECT) fatIds.push(id);
    }
    difat = bytes.length >= sectorSize ? bytes.readUInt32LE(sectorSize - 4) : ENDOFCHAIN;
  }
  if (fatIds.length === 0) throw new CfbError("file has no FAT");

  const perFatSector = sectorSize / 4;
  const fat = new Uint32Array(fatIds.length * perFatSector).fill(FREESECT);
  fatIds.forEach((id, n) => {
    const bytes = sector(id);
    for (let i = 0; i * 4 + 4 <= bytes.length; i++) {
      fat[n * perFatSector + i] = bytes.readUInt32LE(i * 4);
    }
  });

  /**
   * Walk a chain. With `count` it stops after exactly that many sectors
   * (and fails if the chain ends first); without, it reads to ENDOFCHAIN.
   * Either way it never takes more than `limit` steps.
   */
  const walk = (
    start: number,
    table: Uint32Array,
    limit: number,
    what: string,
    count?: number,
  ): number[] => {
    const ids: number[] = [];
    let cur = start;
    while (count === undefined ? cur !== ENDOFCHAIN : ids.length < count) {
      if (cur === ENDOFCHAIN || cur === FREESECT) {
        throw new CfbError(`${what} ends early (truncated?)`);
      }
      if (cur > MAXREGSECT || cur >= table.length || cur >= limit) {
        throw new CfbError(`${what} points outside the file`);
      }
      if (ids.length >= limit) {
        throw new CfbError(`${what} loops or is longer than the file`);
      }
      ids.push(cur);
      cur = table[cur]!;
    }
    return ids;
  };

  const readFat = (start: number, size: number, what: string): Buffer => {
    const need = Math.ceil(size / sectorSize);
    if (need > sectorCount) throw new CfbError(`${what} is larger than the file`);
    const out = Buffer.alloc(size);
    let pos = 0;
    for (const id of walk(start, fat, sectorCount, what, need)) {
      const bytes = sector(id);
      const take = Math.min(bytes.length, size - pos);
      bytes.copy(out, pos, 0, take);
      pos += take;
    }
    if (pos < size) throw new CfbError(`${what} is cut off (truncated?)`);
    return out;
  };

  const readChain = (start: number, what: string): Buffer => {
    if (start === ENDOFCHAIN || start === FREESECT) return Buffer.alloc(0);
    const ids = walk(start, fat, sectorCount, what);
    return Buffer.concat(ids.map(sector));
  };

  // ---- Directory.
  const dirBytes = readChain(data.readUInt32LE(0x30), "directory chain");
  const entries: CfbEntry[] = [];
  const links: Array<[number, number, number]> = [];
  for (let off = 0; off + DIR_ENTRY_SIZE <= dirBytes.length; off += DIR_ENTRY_SIZE) {
    const nameLen = dirBytes.readUInt16LE(off + 0x40);
    const rawType = dirBytes[off + 0x42];
    const name =
      nameLen >= 2 && nameLen <= 64
        ? dirBytes.subarray(off, off + nameLen - 2).toString("utf16le")
        : "";
    const low = dirBytes.readUInt32LE(off + 0x78);
    const high = majorVersion === 4 ? dirBytes.readUInt32LE(off + 0x7c) : 0;
    entries.push({
      index: entries.length,
      name,
      type: rawType === 5 ? "root" : rawType === 1 ? "storage" : rawType === 2 ? "stream" : "unknown",
      start: dirBytes.readUInt32LE(off + 0x74),
      size: high > 0 ? Number.MAX_SAFE_INTEGER : low,
      children: new Map(),
    });
    links.push([
      dirBytes.readUInt32LE(off + 0x44),
      dirBytes.readUInt32LE(off + 0x48),
      dirBytes.readUInt32LE(off + 0x4c),
    ]);
  }
  const root = entries[0];
  if (!root || root.type !== "root") throw new CfbError("directory has no root entry");

  // Each storage's children form a sibling tree (left/right links) hung
  // off its `child` link. An entry is claimed by at most one parent, which
  // also makes cycles in the links harmless.
  const claimed = new Uint8Array(entries.length);
  claimed[0] = 1;
  const storages = [0];
  while (storages.length > 0) {
    const parent = entries[storages.pop()!]!;
    const stack = [links[parent.index]![2]];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (idx === NOSTREAM || idx >= entries.length || claimed[idx]) continue;
      claimed[idx] = 1;
      const e = entries[idx]!;
      const [left, right] = links[idx]!;
      stack.push(left, right);
      if (e.type === "unknown" || e.type === "root") continue;
      parent.children.set(e.name.toUpperCase(), idx);
      if (e.type === "storage") storages.push(idx);
    }
  }

  // ---- Mini stream (held by the root entry) and mini FAT, loaded lazily.
  let mini: { stream: Buffer; table: Uint32Array } | undefined;
  const miniState = (): { stream: Buffer; table: Uint32Array } => {
    if (mini) return mini;
    const stream = root.size > 0 ? readFat(root.start, root.size, "mini stream") : Buffer.alloc(0);
    const tableBytes = readChain(data.readUInt32LE(0x3c), "mini FAT chain");
    const table = new Uint32Array(Math.floor(tableBytes.length / 4));
    for (let i = 0; i < table.length; i++) table[i] = tableBytes.readUInt32LE(i * 4);
    mini = { stream, table };
    return mini;
  };

  const readMini = (start: number, size: number, what: string): Buffer => {
    const { stream, table } = miniState();
    const miniCount = Math.ceil(stream.length / MINI_SECTOR_SIZE);
    const need = Math.ceil(size / MINI_SECTOR_SIZE);
    if (need > miniCount) throw new CfbError(`${what} is larger than the mini stream`);
    const out = Buffer.alloc(size);
    let pos = 0;
    for (const id of walk(start, table, miniCount, what, need)) {
      const from = id * MINI_SECTOR_SIZE;
      const take = Math.min(MINI_SECTOR_SIZE, size - pos, stream.length - from);
      stream.copy(out, pos, from, from + take);
      pos += take;
    }
    if (pos < size) throw new CfbError(`${what} is cut off (truncated?)`);
    return out;
  };

  return {
    root,
    entry: (index) => {
      const e = entries[index];
      if (!e) throw new CfbError(`no directory entry ${index}`);
      return e;
    },
    child: (storage, name) => {
      const idx = storage.children.get(name.toUpperCase());
      return idx === undefined ? undefined : entries[idx];
    },
    read: (stream) => {
      if (stream.type !== "stream") throw new CfbError(`"${stream.name}" is not a stream`);
      if (stream.size === 0) return Buffer.alloc(0);
      if (stream.size > data.length) {
        throw new CfbError(`stream "${stream.name}" claims ${stream.size} bytes, more than the file`);
      }
      const what = `stream "${stream.name}"`;
      return stream.size < miniCutoff
        ? readMini(stream.start, stream.size, what)
        : readFat(stream.start, stream.size, what);
    },
  };
}
