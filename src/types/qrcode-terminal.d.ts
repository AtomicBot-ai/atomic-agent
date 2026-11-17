/**
 * `qrcode-terminal` ships without TypeScript definitions. The WhatsApp
 * channel only draws a pairing QR code as text with `generate`.
 */
declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options: { small: boolean },
    callback: (output: string) => void,
  ): void;
}
