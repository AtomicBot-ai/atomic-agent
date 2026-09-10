import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { ISSUE_REPORT_LEVELS } from "../issue-report/report-levels.js";
import type { IssueReportState } from "../issue-report/issue-report-state.js";
import { useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import { fitToWidth } from "./fit-to-width.js";

export interface IssueReportPopupProps {
  report: IssueReportState;
  availableRows: number;
  availableColumns: number;
}

const MAX_WIDTH = 78;

/**
 * The "Report an issue" popup: a level picker, then a confirmation
 * that names the file about to be sent, then the link.
 *
 * Drawn like the coding-mode menu — absolutely positioned inside the
 * content pane, every interior line padded to the inner width so the
 * chat log cannot show through — but centred rather than hung off a
 * toolbar control, because nothing on screen opened it.
 */
export function IssueReportPopup({
  report,
  availableRows,
  availableColumns,
}: IssueReportPopupProps): ReactElement {
  const width = Math.max(30, Math.min(MAX_WIDTH, availableColumns - 2));
  const inner = width - 2;
  const lines = bodyLines(report, inner);
  const height = Math.min(availableRows, lines.length + 2);
  const visible = lines.slice(0, Math.max(0, height - 2));
  return (
    <PopupFrame
      offsetTop={Math.max(0, Math.floor((availableRows - height) / 2))}
      offsetLeft={Math.max(0, Math.floor((availableColumns - width) / 2))}
      width={width}
    >
      {visible.map((line, idx) => (
        <Text key={idx} color={line.color} bold={line.bold} inverse={line.inverse}>
          {fitToWidth(line.text, inner)}
        </Text>
      ))}
    </PopupFrame>
  );
}

interface Line {
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
}

function bodyLines(report: IssueReportState, inner: number): Line[] {
  const title = (t: string): Line => ({
    text: ` ${t}`,
    color: chromeTheme.colors.railForeground,
    bold: true,
  });
  const muted = (t: string): Line => ({ text: ` ${t}`, color: chromeTheme.colors.railMuted });
  const plain = (t: string): Line => ({ text: ` ${t}` });
  const wrap = (t: string): Line[] => wrapText(t, inner - 4).map((s) => plain(`  ${s}`));

  switch (report.step) {
    case "pick": {
      const out: Line[] = [title("REPORT AN ISSUE ON GITHUB"), muted("What may leave this machine?")];
      ISSUE_REPORT_LEVELS.forEach((info, idx) => {
        const selected = idx === report.cursor;
        out.push({
          text: ` ${selected ? "❯" : " "} ${idx + 1}. ${info.label}`,
          inverse: selected,
          bold: selected,
        });
        out.push(...wrapText(info.detail, inner - 6).map((s) => muted(`     ${s}`)));
      });
      out.push(muted("↑↓ move · enter choose · esc cancel"));
      return out;
    }
    case "building":
      return [title("REPORT AN ISSUE ON GITHUB"), plain("Collecting logs and traces…")];
    case "confirm": {
      const p = report.preview;
      if (!p) return [title("REPORT AN ISSUE ON GITHUB"), plain("…")];
      const info = ISSUE_REPORT_LEVELS.find((l) => l.level === p.level);
      const pages = p.comments === 0 ? "one issue body" : `issue body + ${p.comments} comment${p.comments === 1 ? "" : "s"}`;
      // Long values wrap onto indented continuation lines rather than
      // being cut: the zip path and the disclosure are the two things
      // this screen exists to show in full.
      const field = (label: string, value: string): Line[] =>
        wrapText(value, inner - 10).map((s, i) =>
          plain(`${i === 0 ? label.padEnd(8) : "        "}${s}`),
        );
      return [
        title("SEND THIS REPORT?"),
        ...field("Title:", p.title),
        ...field("Level:", `${info?.label ?? p.level} — ${info?.disclosure ?? ""}`),
        ...field("To:", "github.com/AtomicBot-ai/atomic-agent — a public issue, under your account"),
        ...field("Inline:", `${pages}, ${p.bodyChars.toLocaleString()} chars in the body`),
        ...(p.overflow.length > 0
          ? wrapText(`Not inline (too large): ${p.overflow.join(", ")}`, inner - 10).map((s) => muted(`        ${s}`))
          : []),
        ...field("Zip:", `${p.zipPath} (${formatBytes(p.zipBytes)}) — open it to see exactly what is included`),
        muted("enter/y send · esc/n cancel"),
      ];
    }
    case "sending":
      return [title("REPORT AN ISSUE ON GITHUB"), plain("Filing the issue…")];
    case "sent":
      return [
        title("ISSUE FILED"),
        plain(report.url ?? ""),
        ...(report.preview ? [muted(`zip kept at ${report.preview.zipPath}`)] : []),
        muted("any key to close"),
      ];
    case "error":
      return [
        { text: " COULD NOT FILE THE ISSUE", color: chromeTheme.colors.warn, bold: true },
        ...wrap(report.error ?? "unknown error"),
        ...(report.preview ? [muted(`the zip is still at ${report.preview.zipPath}`)] : []),
        muted("any key to close"),
      ];
    default:
      return [title("REPORT AN ISSUE ON GITHUB")];
  }
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      if (line.length + word.length + 1 > w && line.length > 0) {
        out.push(line);
        line = word;
      } else {
        line = line.length === 0 ? word : `${line} ${word}`;
      }
    }
    out.push(line);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function PopupFrame({
  offsetTop,
  offsetLeft,
  width,
  children,
}: {
  offsetTop: number;
  offsetLeft: number;
  width: number;
  children: ReactNode;
}): ReactElement {
  const ref = useMouseTarget((hit) => isPrimaryPress(hit.event), {
    layer: MOUSE_LAYER_MODAL,
  });
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={offsetTop}
      marginLeft={offsetLeft}
      borderStyle="round"
      borderColor={chromeTheme.colors.railMuted}
      backgroundColor={chromeTheme.colors.railBackground}
      width={width}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}
