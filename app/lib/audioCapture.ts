// Microphone capture with a precise wall-clock anchor for the first captured frame.
//
// Why AudioWorklet instead of MediaRecorder: we need to know, as accurately as
// possible, the `performance.now()` instant corresponding to the START of the clip
// we send for recognition. ACRCloud's play_offset_ms is the song position at that
// instant, so any error in the anchor translates directly into sync error. The
// worklet hands us raw PCM frame-by-frame; we map the AudioContext clock to
// performance.now() via getOutputTimestamp() at the moment the first frame arrives.

export interface CapturedClip {
  /** 16-bit PCM mono WAV. */
  wav: Blob;
  /** performance.now() corresponding to the first captured sample. */
  clipStartPerf: number;
  sampleRate: number;
}

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private chunks: Float32Array[] = [];
  private collecting = false;
  private clipStartPerf = 0;
  private sawFirstFrame = false;

  /** Ask for mic permission and wire up the worklet graph (idempotent). */
  async init(): Promise<void> {
    if (this.ctx) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/recorder-worklet.js");

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "recorder-processor");

    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.collecting) return;
      if (!this.sawFirstFrame) {
        this.sawFirstFrame = true;
        this.clipStartPerf = this.estimateFrameStartPerf();
      }
      this.chunks.push(e.data);
    };

    // Route through a zero-gain node so the graph pulls audio without echoing it out.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  /**
   * Map the audio render clock to performance.now() for the just-arrived frame.
   * getOutputTimestamp() gives {contextTime, performanceTime}; we offset by how far
   * the context clock has advanced past that reference.
   */
  private estimateFrameStartPerf(): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && typeof ts.performanceTime === "number" && ts.contextTime != null) {
      const ahead = (ctx.currentTime - ts.contextTime) * 1000;
      return ts.performanceTime + ahead;
    }
    // Fallback if getOutputTimestamp is unavailable.
    return performance.now();
  }

  /** Record `durationMs` of audio, then resolve with the encoded clip + anchor. */
  async recordClip(durationMs = 6000): Promise<CapturedClip> {
    if (!this.ctx) await this.init();
    if (this.ctx!.state === "suspended") await this.ctx!.resume();

    this.chunks = [];
    this.sawFirstFrame = false;
    this.collecting = true;

    await new Promise((r) => setTimeout(r, durationMs));
    this.collecting = false;

    const sampleRate = this.ctx!.sampleRate;
    const pcm = mergeChunks(this.chunks);
    this.chunks = [];

    return {
      wav: encodeWav(pcm, sampleRate),
      clipStartPerf: this.clipStartPerf || performance.now(),
      sampleRate,
    };
  }

  /** Release the mic and audio context. */
  async dispose(): Promise<void> {
    this.collecting = false;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== "closed") await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode mono Float32 PCM as a 16-bit WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
