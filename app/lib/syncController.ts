// Orchestrates the full listen -> identify -> sync -> play -> drift-correct flow.
// Holds no React state itself; it reports progress through callbacks so the UI can
// stay a thin view layer.

import { AudioCapture } from "./audioCapture";
import { SpotifyController } from "./spotifyPlayer";
import { driftMs, targetSeekMs, type SyncAnchor } from "./syncMath";
import { loadSyncSettings, type SyncSettings } from "./syncSettings";
import type { IdentifyResponse, IdentifyResult, SyncPhase } from "./types";

const LATENCY_STORAGE_KEY = "s2m_start_latency_ms";

export interface SyncCallbacks {
  onPhase: (phase: SyncPhase, detail?: string) => void;
  onTrack: (result: IdentifyResult) => void;
  onDrift?: (driftMs: number) => void;
}

export class SyncController {
  private capture = new AudioCapture();
  private spotify: SpotifyController;
  private cb: SyncCallbacks;

  private anchor: SyncAnchor | null = null;
  private currentTrackId: string | null = null;
  private userTrimMs = 0;
  private settings: SyncSettings;
  private startLatencyMs: number;

  constructor(getToken: () => Promise<string>, cb: SyncCallbacks) {
    this.spotify = new SpotifyController(getToken);
    this.cb = cb;
    this.settings = loadSyncSettings();
    this.startLatencyMs = loadLearnedLatency(this.settings.defaultStartLatencyMs);
  }

  setUserTrimMs(ms: number): void {
    this.userTrimMs = ms;
  }

  /** Re-read sync tuning (e.g. after the user changes it on the Settings page). */
  reloadSettings(): void {
    this.settings = loadSyncSettings();
  }

  /** Connect the Spotify player (loads SDK, registers device). */
  async connectSpotify(): Promise<void> {
    await this.spotify.connect();
  }

  /**
   * Unlock browser audio. MUST be called synchronously from a user gesture
   * (e.g. the click handler) BEFORE the long record/identify pipeline, or the
   * browser blocks autoplay and playback is silent despite reporting "playing".
   */
  async prepareAudio(): Promise<void> {
    await this.spotify.activate();
  }

  /**
   * The main action: record a clip, identify it, and start synced playback.
   * Captures clipStartPerf precisely so the recognition offset has a real anchor.
   */
  async listenAndSync(): Promise<void> {
    try {
      this.cb.onPhase("listening");
      const clip = await this.capture.recordClip(this.settings.clipDurationMs);

      this.cb.onPhase("identifying");
      const result = await this.identify(clip.wav);
      if (!result) return; // phase already set to no_match / error

      if (!result.spotifyTrackId) {
        this.cb.onPhase(
          "error",
          `Identified "${result.title}" but no Spotify track is available for it.`
        );
        return;
      }

      this.cb.onTrack(result);
      this.anchor = {
        playOffsetMs: result.playOffsetMs,
        clipStartPerf: clip.clipStartPerf,
      };
      this.currentTrackId = result.spotifyTrackId;

      this.cb.onPhase("syncing");
      await this.startSynced();

      this.cb.onPhase("playing");
      // Let playback settle, then measure real latency and correct once.
      setTimeout(() => this.correctDrift().catch(() => {}), 1500);
    } catch (err: any) {
      this.cb.onPhase("error", err?.message ?? String(err));
    }
  }

  private async identify(wav: Blob): Promise<IdentifyResult | null> {
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    const data = (await res.json()) as IdentifyResponse;
    if (data.status === "ok") return data.result;
    if (data.status === "no_match") {
      this.cb.onPhase("no_match");
      return null;
    }
    this.cb.onPhase("error", data.message);
    return null;
  }

  /** Seek+play to the projected live position, accounting for start latency. */
  private async startSynced(): Promise<void> {
    if (!this.anchor || !this.currentTrackId) return;
    await this.spotify.activate();

    const seek = targetSeekMs({
      anchor: this.anchor,
      nowPerf: performance.now(),
      startLatencyMs: this.startLatencyMs,
      userTrimMs: this.userTrimMs,
    });
    await this.spotify.startTrackAt(this.currentTrackId, seek);
  }

  /**
   * Closed-loop correction: compare where Spotify actually is to where the live
   * song should be, fold the error into the learned start-latency, and do one
   * corrective seek if it exceeds the deadband.
   */
  async correctDrift(): Promise<void> {
    if (!this.anchor) return;
    const state = await this.spotify.getState();
    if (!state || state.paused) return;

    const drift = driftMs({
      anchor: this.anchor,
      reportedPositionMs: state.positionMs,
      reportedAtPerf: state.perfTimestamp,
      nowPerf: performance.now(),
      paused: state.paused,
      userTrimMs: this.userTrimMs,
    });
    this.cb.onDrift?.(drift);

    // The portion of drift not explained by user trim reflects start-latency error.
    this.startLatencyMs = clamp(
      this.startLatencyMs + drift * this.settings.latencyLearnRate,
      0,
      3000
    );
    saveLearnedLatency(this.startLatencyMs);

    if (Math.abs(drift) > this.settings.driftDeadbandMs) {
      // Re-project to "now" at the moment we actually issue the seek.
      const seek =
        targetSeekMs({
          anchor: this.anchor,
          nowPerf: performance.now(),
          startLatencyMs: 0, // seek is ~immediate vs a fresh play
          userTrimMs: this.userTrimMs,
        });
      await this.spotify.seek(seek);
    }
  }

  /** Manual nudge: shift Spotify by deltaMs immediately (+ later, - earlier). */
  async nudge(deltaMs: number): Promise<void> {
    const state = await this.spotify.getState();
    if (!state) return;
    await this.spotify.seek(state.positionMs + deltaMs);
    // Treat a manual nudge as feedback about our latency estimate too.
    this.startLatencyMs = clamp(this.startLatencyMs + deltaMs, 0, 3000);
    saveLearnedLatency(this.startLatencyMs);
  }

  async stop(): Promise<void> {
    await this.spotify.pause();
  }

  async dispose(): Promise<void> {
    await this.capture.dispose();
    await this.spotify.disconnect();
  }

  get learnedLatencyMs(): number {
    return this.startLatencyMs;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function loadLearnedLatency(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(LATENCY_STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function saveLearnedLatency(ms: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LATENCY_STORAGE_KEY, String(Math.round(ms)));
}
