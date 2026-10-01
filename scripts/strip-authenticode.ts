/**
 * Removes the Authenticode signature from a Windows PE file in place.
 *
 * The SEA binary starts as a copy of the official `node.exe`, which the
 * Node.js project signs. postject then rewrites the PE (it adds the
 * NODE_SEA_BLOB resource), and the old signature does not survive that:
 * postject warns "The signature seems corrupted!" and the certificate-table
 * entry in the header ends up pointing at bytes that are no longer a
 * certificate. `signtool sign` refuses such a file with 0x800700C1
 * (ERROR_BAD_EXE_FORMAT), which is how v0.6.6 shipped an unsigned
 * atomic-agent.exe. Node's SEA guide says to strip the signature before
 * injecting (`signtool remove /s`); this does the same without needing the
 * Windows SDK on the build path.
 *
 * The certificate table is always the last thing in a signed PE, so removing
 * it means truncating the file at its offset and zeroing the header entry.
 * The PE checksum is left as is: Windows only checks it for drivers, and
 * `signtool sign` recomputes it when it signs the result.
 */
import { open } from "node:fs/promises";

/** Data-directory index of IMAGE_DIRECTORY_ENTRY_SECURITY. */
const SECURITY_DIRECTORY = 4;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

/**
 * Returns `true` when a signature was removed and `false` when the file had
 * none. Throws when the file is not a PE image or the table lies outside it.
 */
export async function stripAuthenticode(path: string): Promise<boolean> {
  const file = await open(path, "r+");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(4096);
    await file.read(header, 0, header.length, 0);

    if (header.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`${path} is not a PE file (no MZ header)`);
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (header.readUInt32LE(peOffset) !== 0x00004550) {
      throw new Error(`${path} is not a PE file (no PE signature)`);
    }
    // PE signature (4) + COFF header (20) = start of the optional header.
    const optional = peOffset + 24;
    const magic = header.readUInt16LE(optional);
    if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) {
      throw new Error(`${path} has an unknown optional-header magic 0x${magic.toString(16)}`);
    }
    const directories = optional + (magic === PE32_PLUS_MAGIC ? 112 : 96);
    const entry = directories + SECURITY_DIRECTORY * 8;
    // Unlike every other data directory, this one holds a file offset, not an RVA.
    const tableOffset = header.readUInt32LE(entry);
    const tableSize = header.readUInt32LE(entry + 4);
    if (tableOffset === 0 && tableSize === 0) return false;
    // Truncating is only safe when the table really is the tail of the file
    // (up to the 8-byte alignment padding). Anything after it would be lost.
    const tableEnd = tableOffset + tableSize;
    if (tableEnd > size || size - tableEnd >= 8) {
      throw new Error(
        `${path}: certificate table (${tableOffset}+${tableSize}) is not at the end of the file (${size})`,
      );
    }

    await file.write(Buffer.alloc(8), 0, 8, entry);
    await file.truncate(tableOffset);
    return true;
  } finally {
    await file.close();
  }
}
