import JSZip from "jszip";
import {
  PRES_PROPS_XML,
  TABLE_STYLES_XML,
  VIEW_PROPS_XML,
  appPropsXml,
  contentTypesXml,
  corePropsXml,
  notesMasterXml,
  presentationRels,
  presentationXml,
  slideLayoutXml,
  slideMasterXml,
} from "./pptx-parts.js";
import type { PptxImageInfo } from "./pptx-image.js";
import { isTitleSlide, notesSlideXml, slideXml, type PlacedImage } from "./pptx-slide.js";
import type { PptxDeckSpec } from "./pptx-spec.js";
import { resolvePalette, themeXml } from "./pptx-theme.js";
import { relationships } from "./pptx-xml.js";

/**
 * Assemble a deck into PPTX bytes. Pure: pictures arrive already read
 * and sniffed (`write-pptx-tool.ts` does the disk I/O), so the same
 * spec and clock always give the same file.
 *
 * Written with JSZip, which the reader side (`read-document`) already
 * ships — no new dependency, no Python.
 */

export interface PptxImageInput {
  data: Buffer;
  info: PptxImageInfo;
  /** File name for the picture's alt text. */
  name: string;
}

export interface BuildPptxInput {
  spec: PptxDeckSpec;
  /** Picture per slide index (0-based); slides without one are absent. */
  images?: ReadonlyMap<number, PptxImageInput>;
  now?: Date;
}

export interface BuildPptxResult {
  data: Buffer;
  slideCount: number;
  notesCount: number;
  imageCount: number;
}

const EXTENSION: Record<PptxImageInfo["kind"], string> = { png: "png", jpeg: "jpeg", gif: "gif" };

export async function buildPptx(input: BuildPptxInput): Promise<BuildPptxResult> {
  const { spec } = input;
  const images = input.images ?? new Map<number, PptxImageInput>();
  const palette = resolvePalette(spec);
  const slideCount = spec.slides.length;
  const notesSlides: number[] = [];
  const zip = new JSZip();
  // [Content_Types].xml goes first: some readers sniff the zip's first
  // entry. Its content is filled in at the end (it lists the notes);
  // re-setting an entry keeps its place in JSZip's order.
  zip.file("[Content_Types].xml", "");

  zip.file(
    "_rels/.rels",
    relationships([
      { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
      {
        id: "rId2",
        type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        target: "docProps/core.xml",
      },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]),
  );
  zip.file("ppt/presentation.xml", presentationXml(slideCount));
  zip.file("ppt/_rels/presentation.xml.rels", relationships(presentationRels(slideCount)));
  zip.file("ppt/presProps.xml", PRES_PROPS_XML);
  zip.file("ppt/viewProps.xml", VIEW_PROPS_XML);
  zip.file("ppt/tableStyles.xml", TABLE_STYLES_XML);
  zip.file("ppt/theme/theme1.xml", themeXml(palette));
  // The notes master needs a theme of its own; the deck's is fine.
  zip.file("ppt/theme/theme2.xml", themeXml(palette));
  zip.file("ppt/slideMasters/slideMaster1.xml", slideMasterXml(palette));
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relationships([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
  );
  zip.file("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml());
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    relationships([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  zip.file("ppt/notesMasters/notesMaster1.xml", notesMasterXml());
  zip.file(
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    relationships([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]),
  );

  let imageCount = 0;
  spec.slides.forEach((slide, index) => {
    const n = index + 1;
    const rels = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    if (slide.notes !== undefined) {
      notesSlides.push(n);
      rels.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/notesSlide${n}.xml` });
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesSlideXml(slide.notes));
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        relationships([
          { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
          { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
        ]),
      );
    }
    const picture = images.get(index);
    let placed: PlacedImage | undefined;
    // A title slide has no room set aside for a picture; the parser
    // never produces one with an image, but a hand-built spec could.
    if (picture && !isTitleSlide(slide)) {
      imageCount += 1;
      const media = `image${imageCount}.${EXTENSION[picture.info.kind]}`;
      zip.file(`ppt/media/${media}`, picture.data);
      rels.push({ id: "rId3", type: "image", target: `../media/${media}` });
      placed = { info: picture.info, relId: "rId3", name: picture.name };
    }
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(slide, palette, placed));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, relationships(rels));
  });

  const deckTitle = spec.title ?? spec.slides[0]?.title ?? "Presentation";
  zip.file("docProps/core.xml", corePropsXml(deckTitle, spec.author ?? "Atomic Agent", input.now ?? new Date()));
  zip.file("docProps/app.xml", appPropsXml(slideCount, notesSlides.length));
  zip.file("[Content_Types].xml", contentTypesXml(slideCount, notesSlides));

  const data = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { data, slideCount, notesCount: notesSlides.length, imageCount };
}
