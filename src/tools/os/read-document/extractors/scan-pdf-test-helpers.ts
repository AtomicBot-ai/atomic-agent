/**
 * Test helper (ATO-2205): a small PDF in memory whose pages are either a
 * text line (a text layer) or one gray image covering the page (what a
 * scanner writes: pixels, no text). Uncompressed, so no library is needed.
 */

export interface TestPdfPage {
  /** A line of ASCII text drawn with Helvetica: the page has a text layer. */
  text?: string;
  /** One 8-bit DeviceGray image painted over the whole page. */
  image?: { width: number; height: number; gray?: number };
}

export function buildTestPdf(pages: readonly TestPdfPage[]): Buffer {
  // Object numbers: 1 catalog, 2 pages, 3 font, then per page: page,
  // content, and an image when it has one.
  const bodies: Buffer[] = [
    ascii("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.alloc(0), // pages tree, filled in once the kids are known
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const kids: number[] = [];
  for (const page of pages) {
    const pageObj = bodies.length + 1;
    const contentObj = pageObj + 1;
    const imageObj = page.image ? pageObj + 2 : undefined;
    kids.push(pageObj);
    const parts: string[] = [];
    if (page.image) parts.push("q 612 0 0 792 0 0 cm /Im1 Do Q");
    if (page.text !== undefined) parts.push(`BT /F1 18 Tf 72 700 Td (${page.text}) Tj ET`);
    const content = parts.join("\n");
    const xobject = imageObj !== undefined ? ` /XObject << /Im1 ${imageObj} 0 R >>` : "";
    bodies.push(
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R ` +
          `/Resources << /Font << /F1 3 0 R >>${xobject} >> >>`,
      ),
    );
    bodies.push(stream(`<< /Length ${content.length} >>`, ascii(content)));
    if (page.image) {
      const { width, height, gray = 200 } = page.image;
      const pixels = Buffer.alloc(width * height, gray);
      bodies.push(
        stream(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>`,
          pixels,
        ),
      );
    }
  }
  bodies[1] = ascii(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);

  const chunks: Buffer[] = [ascii("%PDF-1.4\n")];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(length);
    const obj = Buffer.concat([ascii(`${i + 1} 0 obj\n`), body, ascii("\nendobj\n")]);
    chunks.push(obj);
    length += obj.length;
  });
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(ascii(xref));
  return Buffer.concat(chunks);
}

function ascii(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([ascii(`${dict}\nstream\n`), data, ascii("\nendstream")]);
}
