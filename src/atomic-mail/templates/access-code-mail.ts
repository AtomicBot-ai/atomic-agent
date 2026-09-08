import { MONO, SCREEN, esc, renderMailShell } from "./mail-shell.js";
import type { RenderedMail } from "./download-mail.js";

/**
 * The verification mail: six digits the operator types back into the
 * Integrations hub to prove the address is theirs. Same CRT shell, an
 * `ACCESS CODE` banner, the digits in their own cells so they read at
 * arm's length.
 */
export interface AccessCodeMailInput {
  code: string;
  /** Minutes until the code stops working. */
  expiresInMinutes: number;
  from: string;
}

export function renderAccessCodeMail(input: AccessCodeMailInput): RenderedMail {
  const digits = [...input.code];
  const cells = digits
    .map(
      (d) =>
        `<td style="width:44px;height:52px;text-align:center;vertical-align:middle;font-family:${MONO};font-size:34px;font-weight:bold;line-height:52px;color:${SCREEN.green};border:2px solid ${SCREEN.bezel};background:${SCREEN.bg}">${esc(d)}</td>`,
    )
    .join(`<td style="width:8px;font-size:1px;line-height:1px">&nbsp;</td>`);
  const codeTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;margin:6px auto"><tr>${cells}</tr></table>`;
  const subject = `▶ ACCESS CODE ${input.code} — Atomic Agent`;
  const text = [
    "ATOMIC AGENT — TRANSMISSION IDENT",
    "",
    "ACCESS CODE",
    "",
    `   ${digits.join("  ")}`,
    "",
    `> type it into Integrations → Atomic Mail within ${input.expiresInMinutes} minutes`,
    "> after that your agent can reach you at this address",
    "",
    "IDENTIFY, COMMANDER",
    "",
    "▶ Didn't ask for this? Ignore it — nothing changes without the code.",
    "",
    `sent by ${input.from} · reply to talk to your agent`,
  ].join("\n");
  const html = renderMailShell({
    transmission: "TRANSMISSION IDENT",
    banner: "ACCESS CODE",
    bannerColor: SCREEN.green,
    readout: [
      codeTable,
      `<span style="color:${SCREEN.green}">&gt;</span> type it into Integrations → Atomic Mail within ${input.expiresInMinutes} minutes`,
      `<span style="color:${SCREEN.green}">&gt;</span> after that your agent can reach you at this address`,
    ],
    status: "IDENTIFY, COMMANDER",
    cta: "Didn't ask for this? Ignore it — nothing changes without the code.",
    from: input.from,
    title: `Access code ${input.code}`,
  });
  return { subject, text, html };
}
