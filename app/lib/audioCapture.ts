// Microphone capture with a precise wall-clock anchor for the first captured frame.
//
// Why AudioWorklet instead of MediaRecorder: we need to know, as accurately as
// possible, the `performance.now()` instant corresponding to the START of the clip
// we send for recognition. ACRCloud's play_offset_ms is the song position at that
// instant, so any error in the anchor translates directly into sync error. The
// worklet tags every block with the audio-clock time it was captured in; we map
// that to performance.now() via getOutputTimestamp() and subtract the device
// latencies, so the anchor is the moment the sound actually hit the microphone.

export interface CapturedClip {
  /** 16-bit PCM mono WAV. */
  wav: Blob;
  /** performance.now() corresponding to the first captured sample. */
  clipStartPerf: number;
  sampleRate: number;
}

/** Microphone problems (permission, missing device) — not worth retrying. */
export class MicError extends Error {}

interface WorkletFrame {
  samples: Float32Array;
  /** AudioContext time of the render quantum the samples were captured in. */
  time: number;
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
  private inputLatencyMs = 0;

  /**
   * How long the default output device takes to make a sample audible (ms).
   * Spotify plays through the same device, so its playback must run this far
   * ahead of the room to be heard in sync. 0 when the browser doesn't report it.
   */
  get outputLatencyMs(): number {
    const latency = this.ctx?.outputLatency;
    return typeof latency === "number" && Number.isFinite(latency) ? latency * 1000 : 0;
  }

  /** Ask for mic permission and wire up the worklet graph (idempotent). */
  async init(): Promise<void> {
    if (this.ctx) return;

    // getUserMedia only exists in a secure context (HTTPS or localhost) and is
    // blocked in cross-origin iframes that don't grant microphone permission.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError(
        "Microphone access isn't available here. Open the app in its own browser " +
          "tab over HTTPS (not inside an embedded preview/iframe)."
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      throw new MicError(describeMicError(err));
    }

    // Chrome reports the capture pipeline latency in the track settings.
    const settings = this.stream.getAudioTracks()[0]?.getSettings() as
      | (MediaTrackSettings & { latency?: number })
      | undefined;
    this.inputLatencyMs =
      typeof settings?.latency === "number" ? settings.latency * 1000 : 0;

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/recorder-worklet.js");

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "recorder-processor");

    this.node.port.onmessage = (e: MessageEvent<WorkletFrame>) => {
      if (!this.collecting) return;
      if (!this.sawFirstFrame) {
        this.sawFirstFrame = true;
        this.clipStartPerf = this.captureTimeToPerf(e.data.time);
      }
      this.chunks.push(e.data.samples);
    };

    // Route through a zero-gain node so the graph pulls audio without echoing it out.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  /**
   * performance.now() at which audio that the graph processed at audio-clock time
   * `contextTime` actually reached the microphone.
   *
   * getOutputTimestamp() maps the audio clock to the moment a frame is *heard*
   * from the output device. Processing happens (baseLatency + outputLatency)
   * before that, and the input samples fed into that processing were captured
   * inputLatency earlier still.
   */
  private captureTimeToPerf(contextTime: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (!ts?.performanceTime || ts.contextTime == null) {
      // No clock mapping available: the frame was captured roughly one
      // quantum (+ input latency) before it reached us.
      return performance.now() - (128 / ctx.sampleRate) * 1000 - this.inputLatencyMs;
    }
    const heardAt = ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    const processingToHeardMs = ((ctx.baseLatency || 0) * 1000) + this.outputLatencyMs;
    return heardAt - processingToHeardMs - this.inputLatencyMs;
  }

  /**
   * Record `durationMs` of audio, then resolve with the encoded clip + anchor.
   * Rejects with an AbortError if `signal` fires (e.g. the user pressed Stop).
   */
  async recordClip(durationMs = 6000, signal?: AbortSignal): Promise<CapturedClip> {
    if (!this.ctx) await this.init();
    if (this.ctx!.state === "suspended") await this.ctx!.resume();
    if (this.collecting) throw new Error("Already recording.");
    throwIfAborted(signal);

    this.chunks = [];
    this.sawFirstFrame = false;
    this.collecting = true;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, durationMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Recording cancelled", "AbortError"));
          },
          { once: true }
        );
      });
    } finally {
      this.collecting = false;
    }

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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Recording cancelled", "AbortError");
}

/** Turn a getUserMedia DOMException into actionable guidance. */
function describeMicError(err: unknown): string {
  const name = (err as DOMException)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Microphone permission was blocked. Click the 🔒/camera icon in the address " +
        "bar, set Microphone to Allow, then reload. If the app is inside an embedded " +
        "preview, open it in its own browser tab. On macOS, also check System " +
        "Settings → Privacy & Security → Microphone for your browser."
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect/enable a mic and try again.";
    case "NotReadableError":
      return "The microphone is in use by another app. Close it and try again.";
    default:
      return (
        "Couldn't access the microphone" +
        ((err as Error)?.message ? `: ${(err as Error).message}` : ".")
      );
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
