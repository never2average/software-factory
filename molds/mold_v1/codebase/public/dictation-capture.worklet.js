/*
 * Dictation's microphone tap (app/_components/dictation-engine.ts): hands the samples to the page in blocks of about
 * 40 ms, off the main thread. A file of its own because an AudioWorklet is loaded by address, and this site's
 * content-security policy takes scripts from its own origin only (proxy.ts).
 */
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const n = Math.min(channel.length - at, this.block.length - this.filled);
      this.block.set(channel.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("dictation-capture", DictationCapture);
