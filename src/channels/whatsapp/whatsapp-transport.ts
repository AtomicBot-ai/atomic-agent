/**
 * The seam between the WhatsApp channel and the library that speaks the
 * WhatsApp Web protocol (ATO-502).
 *
 * The channel only ever sees these interfaces. The real implementation
 * (`whatsapp-baileys.ts`) wraps `baileys`; tests pass a fake, so no test
 * loads baileys or opens a socket.
 */

import type { RawWhatsAppMessage } from "./whatsapp-types.js";

export interface WhatsAppSocketEvents {
  /** A new pairing QR payload (WhatsApp rotates it every ~20 s until scanned). */
  onQr(qr: string): void;
  /** The socket is linked and online. */
  onOpen(): void;
  /** The socket closed; `statusCode` is WhatsApp's disconnect reason when known. */
  onClose(info: { statusCode: number | null; reason: string }): void;
  /** A new incoming message (live, not history sync). */
  onMessage(message: RawWhatsAppMessage): void;
}

export interface WhatsAppSocket {
  sendText(jid: string, text: string): Promise<void>;
  /** Best-effort "typing..." on/off. */
  sendTyping?(jid: string, on: boolean): Promise<void>;
  /** Close without logging the device out. Idempotent. */
  close(): void;
}

export interface WhatsAppConnector {
  /**
   * Open one socket with the session keys in `authDir` (created when
   * missing; empty means a QR code will be offered).
   */
  connect(options: { authDir: string; events: WhatsAppSocketEvents }): Promise<WhatsAppSocket>;
  /** Draw a QR payload as text that a phone camera can scan from a terminal. */
  renderQr(qr: string): Promise<string>;
}

/** Load the connector. Rejects when the protocol library cannot be loaded. */
export type LoadWhatsAppConnector = () => Promise<WhatsAppConnector>;
