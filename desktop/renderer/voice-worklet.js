/* Voice input — the microphone tap.
 *
 * An AudioWorkletProcessor, not a ScriptProcessorNode: the renderer's CSP is
 * `script-src 'self'`, which allows this module because it ships as a real
 * file next to renderer.js (a blob: worklet is refused), and the worklet runs
 * off the main thread so a busy render cannot drop audio.
 *
 * The AudioContext is created at 16 kHz, so Chromium has already resampled
 * the device's 48 kHz down for us and this only has to quantise: Float32 in,
 * mono Int16 little-endian out, 1600 samples (100 ms) per message, plus the
 * block's peak so the composer strip can draw a level without keeping a copy
 * of the audio anywhere.
 */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.at = 0;
    this.peak = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      this.buf[this.at++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.at === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.slice(), peak: this.peak });
        this.at = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);
