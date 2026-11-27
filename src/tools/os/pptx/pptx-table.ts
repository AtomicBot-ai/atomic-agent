import { graphicFrame, runs } from "./pptx-shapes.js";
import type { Box } from "./pptx-xml.js";

/** The built-in "Medium Style 2 - Accent 1", the table style PowerPoint and python-pptx default to. */
export const TABLE_STYLE_ID = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";
const ROW_HEIGHT = 370_840;

/**
 * A native table (`a:tbl`), header row first, in the deck's default
 * table style, so PowerPoint's table tools work on it. Columns share the
 * width evenly; rows get a fixed height that PowerPoint grows to fit.
 */
export function tableShape(rows: readonly string[][], area: Box): string {
  const cols = rows[0]?.length ?? 1;
  const colWidth = Math.floor(area.cx / cols);
  const textSize = rows.length > 12 || cols > 6 ? 1200 : 1600;
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colWidth}"/>`).join("");
  const body = rows
    .map((row) => {
      const cells = row
        .map((value) => {
          const paragraph =
            value.length === 0
              ? `<a:p><a:endParaRPr lang="en-US" sz="${textSize}"/></a:p>`
              : `<a:p>${runs(value, ` sz="${textSize}"`)}</a:p>`;
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph}</a:txBody><a:tcPr/></a:tc>`;
        })
        .join("");
      return `<a:tr h="${ROW_HEIGHT}">${cells}</a:tr>`;
    })
    .join("");
  const box: Box = { ...area, cy: Math.min(area.cy, ROW_HEIGHT * rows.length) };
  return graphicFrame(
    6,
    "Table 5",
    box,
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${TABLE_STYLE_ID}</a:tableStyleId></a:tblPr>` +
      `<a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl>` +
      "</a:graphicData></a:graphic>",
  );
}
