// Orchestrates a sync *session*: listen -> identify -> play in sync -> keep it in
// sync -> when the song ends, listen for the next one and repeat (follow mode).
// Holds no React state itself; it reports progress through callbacks so the UI can
// stay a thin view layer.
//
// Every session has a generation number and an AbortController. Stop (or starting
// a new session) bumps the generation and aborts, so any recording, recognition
// request or timer that belongs to an old session quietly does nothing.

import { AudioCapture, MicError } from "./audioCapture";
import { SpotifyController } from "./spotifyPlayer";
import { driftMs, livePositionMs, targetSeekMs, type SyncAnchor } from "./syncMath";
import {
  classifyPlayback,
  decideAfterListen,
  isSameTrack,
  remainingMs,
} from "./followLogic";
import { loadSyncSettings, type SyncSettings } from "./syncSettings";
import type { IdentifyResponse, IdentifyResult, SyncPhase } from "./types";

const START_LATENCY_KEY = "s2m_start_latency_ms";
const SEEK_LATENCY_KEY = "s2m_seek_latency_ms";
const DEFAULT_SEEK_LATENCY_MS = 150;

/** How often the local Spotify state is checked for end-of-song etc. */
const POLL_INTERVAL_MS = 1000;
/** How often drift is measured and corrected while playing. */
const DRIFT_CHECK_INTERVAL_MS = 10_000;
/** Let a fresh start settle before measuring how late it really started. */
const FIRST_DRIFT_CHECK_MS = 1500;
/** Between follow-mode listening attempts. */
const FOLLOW_RETRY_MS = 1500;
/** Stop following after this long without a playable match. */
const FOLLOW_GIVE_UP_MS = 3 * 60_000;
/** If Spotify hasn't started our track by then, give up. */
const START_TIMEOUT_MS = 15_000;

export interface SyncCallbacks {
  onPhase: (phase: SyncPhase, detail?: string) => void;
  onTrack: (result: IdentifyResult | null) => void;
  onDrift?: (driftMs: number) => void;
}

/** The track we're currently playing in sync. */
interface CurrentTrack {
  result: IdentifyResult;
  trackId: string;
  anchor: SyncAnchor;
  startedAt: number;
  sawPlaying: boolean;
  lastRemainingMs: number | null;
  /** Spotify's duration once known (that's when *our* playback ends). */
  durationMs: number;
  /** One-shot check fired when a shorter room version should have ended. */
  roomEndChecked: boolean;
}

type DriftLearn = "start" | "seek" | null;

export class SyncController {
  private capture = new AudioCapture();
  private spotify: SpotifyController;
  private cb: SyncCallbacks;
  private settings: SyncSettings;

  private userTrimMs = 0;
  private startLatencyMs: number;
  private seekLatencyMs: number;

  // --- session state ---
  private session = 0;
  private abort: AbortController | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;
  private phase: SyncPhase = "idle";
  private current: CurrentTrack | null = null;
  /** The track that just finished, to recognize "room still on the same song". */
  private previous: { trackId: string; durationMs: number } | null = null;
  private waitingSince: number | null = null;
  /** A recording / recognition / corrective seek is in progress. */
  private busy = false;
  private polling = false;
  private lastDriftCheck = 0;
  private lastChangeCheck = 0;
  private wakeLock: { release: () => Promise<void> } | null = null;

  constructor(getToken: () => Promise<string>, cb: SyncCallbacks) {
    this.spotify = new SpotifyController(getToken);
    this.cb = cb;
    this.settings = loadSyncSettings();
    this.startLatencyMs = loadNumber(START_LATENCY_KEY, this.settings.defaultStartLatencyMs);
    this.seekLatencyMs = loadNumber(SEEK_LATENCY_KEY, DEFAULT_SEEK_LATENCY_MS);

    this.spotify.onAutoplayBlocked = () => {
      if (this.abort) {
        void this.stop({
          phase: "error",
          detail: "The browser blocked Spotify's audio. Press Listen & Sync to start it again.",
        });
      }
    };

    if (typeof document !== "undefined") {
      // Wake locks are dropped when the tab is hidden; take it again on return.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.abort) void this.acquireWakeLock();
      });
    }
  }

  get learnedLatencyMs(): number {
    return this.startLatencyMs;
  }

  /** Re-read sync tuning (e.g. after the user changes it on the Settings page). */
  reloadSettings(): void {
    this.settings = loadSyncSettings();
  }

  /**
   * Set the manual offset. While playing, the new offset is applied right away
   * (debounced, so dragging the slider doesn't spam seeks).
   */
  setUserTrimMs(ms: number): void {
    if (ms === this.userTrimMs) return;
    this.userTrimMs = ms;
    if (this.phase !== "playing" || !this.current) return;
    if (this.trimTimer) clearTimeout(this.trimTimer);
    const gen = this.session;
    this.trimTimer = setTimeout(() => {
      this.trimTimer = null;
      void this.runExclusive(() => this.correctDrift(gen, { learn: null, force: true }));
    }, 300);
  }

  /** Connect the Spotify player (loads SDK, registers device). */
  async connectSpotify(): Promise<void> {
    await this.spotify.connect();
  }

  /**
   * Unlock browser audio. MUST be called from a user gesture (the click handler)
   * BEFORE the long record/identify pipeline, or the browser blocks autoplay and
   * playback is silent despite reporting "playing".
   */
  async prepareAudio(): Promise<void> {
    await this.spotify.activate();
  }

  /** Start a fresh session. Stops anything in progress first (incl. our playback,
   *  so it doesn't bleed into the mic). */
  async start(): Promise<void> {
    await this.stop({ silent: true });
    this.settings = loadSyncSettings();
    this.previous = null;
    const gen = ++this.session;
    this.abort = new AbortController();
    void this.acquireWakeLock();
    await this.listenCycle(gen, { first: true });
  }

  /** Re-align playback to the room right now (no re-listen). */
  async realign(): Promise<void> {
    const gen = this.session;
    await this.runExclusive(() => this.correctDrift(gen, { learn: null, force: true }));
  }

  /** End the session: cancel everything in flight and pause Spotify. */
  async stop(opts: { silent?: boolean; phase?: SyncPhase; detail?: string } = {}): Promise<void> {
    this.session++;
    this.abort?.abort();
    this.abort = null;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.stopPolling();
    if (this.trimTimer) clearTimeout(this.trimTimer);
    this.trimTimer = null;
    this.current = null;
    this.waitingSince = null;
    this.busy = false;
    this.releaseWakeLock();
    try {
      await this.spotify.pause();
    } catch {
      /* not connected / nothing playing */
    }
    if (!opts.silent) this.setPhase(opts.phase ?? "idle", opts.detail);
  }

  async dispose(): Promise<void> {
    await this.stop({ silent: true });
    await this.capture.dispose();
    await this.spotify.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Listen -> identify -> decide
  // ---------------------------------------------------------------------------

  private async listenCycle(gen: number, opts: { first: boolean }): Promise<void> {
    // A mid-song check may still be finishing with the microphone.
    while (this.busy) {
      await sleep(100);
      if (!this.alive(gen)) return;
    }
    if (!this.alive(gen)) return;

    this.busy = true;
    let clipStartPerf: number;
    let outcome: IdentifyResponse;
    try {
      this.setPhase(opts.first ? "listening" : "waiting", opts.first ? undefined : this.waitingDetail());
      const clip = await this.capture.recordClip(
        opts.first ? this.settings.clipDurationMs : this.settings.followClipDurationMs,
        this.abort?.signal
      );
      clipStartPerf = clip.clipStartPerf;
      if (!this.alive(gen)) return;
      if (opts.first) this.setPhase("identifying");
      outcome = await this.identify(clip.wav, this.abort?.signal);
    } catch (err) {
      if (!this.alive(gen) || isAbort(err)) return;
      // Network hiccups shouldn't end a follow session; mic errors should.
      if (!opts.first && this.settings.autoFollow && !(err instanceof MicError)) {
        return this.retryFollow(gen, "Connection problem — retrying…");
      }
      return this.fail(err);
    } finally {
      this.busy = false;
    }
    if (!this.alive(gen)) return;

    if (outcome.status === "error") return this.fail(new Error(outcome.message));

    if (outcome.status === "no_match") {
      if (this.settings.autoFollow) return this.retryFollow(gen);
      return this.stop({ phase: "no_match" });
    }

    const result = outcome.result;
    if (!result.spotifyTrackId) {
      const msg = `"${result.title}" isn't available on Spotify.`;
      if (this.settings.autoFollow) return this.retryFollow(gen, `${msg} Waiting for the next song…`);
      return this.stop({ phase: "error", detail: msg });
    }

    const decision = decideAfterListen(
      { spotifyTrackId: result.spotifyTrackId, playOffsetMs: result.playOffsetMs },
      this.previous,
      performance.now() - clipStartPerf
    );
    if (decision === "wait") {
      return this.retryFollow(gen, "The room is still finishing this song — waiting for the next one…");
    }

    await this.playTrack(gen, result, {
      playOffsetMs: result.playOffsetMs,
      clipStartPerf,
    });
  }

  private waitingDetail(): string {
    return this.previous ? "Song ended — listening for the next one…" : "Listening for music…";
  }

  /** No playable match yet: try again shortly, until we give up. */
  private retryFollow(gen: number, detail?: string): void {
    if (this.waitingSince === null) this.waitingSince = performance.now();
    if (performance.now() - this.waitingSince > FOLLOW_GIVE_UP_MS) {
      void this.stop({
        phase: "no_match",
        detail: "No recognizable music for a few minutes — stopped listening.",
      });
      return;
    }
    this.setPhase("waiting", detail ?? this.waitingDetail());
    this.later(gen, FOLLOW_RETRY_MS, () => this.listenCycle(gen, { first: false }));
  }

  private async identify(wav: Blob, signal?: AbortSignal): Promise<IdentifyResponse> {
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
      signal,
    });
    return (await res.json()) as IdentifyResponse;
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  private async playTrack(gen: number, result: IdentifyResult, anchor: SyncAnchor): Promise<void> {
    this.setPhase("syncing");
    this.cb.onTrack(result);
    this.waitingSince = null;

    const seek = targetSeekMs({
      anchor,
      nowPerf: performance.now(),
      startLatencyMs: this.startLatencyMs,
      userTrimMs: this.effectiveTrimMs(),
    });
    try {
      await this.spotify.startTrackAt(result.spotifyTrackId!, seek);
    } catch (err) {
      if (!this.alive(gen)) return;
      return this.fail(err);
    }
    if (!this.alive(gen)) return;

    this.current = {
      result,
      trackId: result.spotifyTrackId!,
      anchor,
      startedAt: performance.now(),
      sawPlaying: false,
      lastRemainingMs: null,
      durationMs: 0,
      roomEndChecked: false,
    };
    this.lastDriftCheck = performance.now();
    this.lastChangeCheck = performance.now();
    this.setPhase("playing");

    // Measure how late Spotify really started, learn from it, and correct.
    this.later(gen, FIRST_DRIFT_CHECK_MS, () =>
      this.runExclusive(() => this.correctDrift(gen, { learn: "start" }))
    );
    this.startPolling(gen);
  }

  private startPolling(gen: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(gen), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Once a second: has our song ended / been replaced / paused elsewhere? */
  private async poll(gen: number): Promise<void> {
    if (!this.alive(gen) || !this.current || this.polling) return;
    this.polling = true;
    try {
      const snap = await this.spotify.getSnapshot();
      const cur = this.current;
      if (!this.alive(gen) || !cur) return;

      const status = classifyPlayback(snap, cur.trackId, {
        sawOurTrackPlaying: cur.sawPlaying,
        lastRemainingMs: cur.lastRemainingMs,
      });

      switch (status) {
        case "starting":
          if (performance.now() - cur.startedAt > START_TIMEOUT_MS) {
            await this.stop({
              phase: "error",
              detail: "Spotify didn't start playing. Press Listen & Sync to try again.",
            });
          }
          return;
        case "playing":
          cur.sawPlaying = true;
          if (snap!.durationMs) cur.durationMs = snap!.durationMs;
          cur.lastRemainingMs = remainingMs(snap!.durationMs, snap!.positionMs);
          this.periodicChecks(gen, cur);
          return;
        case "ended":
        case "switched":
          await this.onTrackFinished(gen, cur);
          return;
        case "external_pause":
          await this.stop({ phase: "idle", detail: "Paused from another Spotify app." });
          return;
        case "lost":
          await this.stop({ phase: "idle", detail: "Playback moved to another Spotify device." });
          return;
      }
    } finally {
      this.polling = false;
    }
  }

  /** While playing: drift checks, optional song-change checks. Never blocks polling. */
  private periodicChecks(gen: number, cur: CurrentTrack): void {
    if (this.busy) return;
    const now = performance.now();
    const followClip = this.settings.followClipDurationMs;
    const roomTimeLeftOk = (cur.lastRemainingMs ?? Infinity) > followClip + 5000;

    // The room's version (per ACRCloud) is shorter than Spotify's: when it
    // should have ended, check whether the room has moved on.
    const roomDuration = cur.result.durationMs;
    if (
      !cur.roomEndChecked &&
      roomDuration &&
      cur.durationMs &&
      roomDuration < cur.durationMs - 3000 &&
      livePositionMs(cur.anchor, now) > roomDuration + 1000 &&
      roomTimeLeftOk
    ) {
      cur.roomEndChecked = true;
      void this.changeCheck(gen);
      return;
    }

    const interval = this.settings.changeCheckIntervalSec * 1000;
    if (interval > 0 && now - this.lastChangeCheck >= interval && roomTimeLeftOk) {
      this.lastChangeCheck = now;
      void this.changeCheck(gen);
      return;
    }

    if (now - this.lastDriftCheck >= DRIFT_CHECK_INTERVAL_MS) {
      this.lastDriftCheck = now;
      void this.runExclusive(() => this.correctDrift(gen, { learn: null }));
    }
  }

  /** Our song ended (or Spotify autoplay replaced it): follow the room. */
  private async onTrackFinished(gen: number, cur: CurrentTrack): Promise<void> {
    this.current = null;
    this.stopPolling();
    this.previous = { trackId: cur.trackId, durationMs: cur.durationMs };
    try {
      await this.spotify.pause(); // stops a Spotify-autoplay pick, if any
    } catch {
      /* ignore */
    }
    if (!this.alive(gen)) return;

    if (!this.settings.autoFollow) {
      await this.stop({ phase: "idle", detail: "Song finished." });
      return;
    }
    this.waitingSince = performance.now();
    this.setPhase("waiting", this.waitingDetail());
    // Give the room's next song a moment to actually start.
    this.later(gen, 500, () => this.listenCycle(gen, { first: false }));
  }

  /**
   * Mid-song check: re-identify the room. A different song means the room moved
   * on early (DJ cut) -> switch. The same song, heard with Spotify muted, gives a
   * fresh anchor from the real room audio -> re-align against it.
   */
  private async changeCheck(gen: number): Promise<void> {
    const cur = this.current;
    if (this.busy || !cur) return;
    this.busy = true;
    const mute = this.settings.muteDuringCheck;
    let restoreVolume: number | null = null;
    try {
      if (mute) {
        restoreVolume = await this.spotify.getVolume();
        await this.spotify.setVolume(0);
      }
      const clip = await this.capture.recordClip(
        this.settings.followClipDurationMs,
        this.abort?.signal
      );
      if (restoreVolume !== null) {
        await this.spotify.setVolume(restoreVolume);
        restoreVolume = null;
      }
      if (!this.alive(gen) || this.current !== cur) return;

      const outcome = await this.identify(clip.wav, this.abort?.signal);
      if (!this.alive(gen) || this.current !== cur) return;
      if (outcome.status !== "ok" || !outcome.result.spotifyTrackId) return; // keep playing

      const result = outcome.result;
      const anchor = { playOffsetMs: result.playOffsetMs, clipStartPerf: clip.clipStartPerf };

      if (result.spotifyTrackId !== cur.trackId) {
        this.current = null;
        this.stopPolling();
        this.previous = { trackId: cur.trackId, durationMs: cur.durationMs };
        this.busy = false;
        await this.playTrack(gen, result, anchor);
        return;
      }
      if (mute) {
        // Same song, and we only heard the room: trust this newer anchor.
        cur.anchor = anchor;
        await this.correctDrift(gen, { learn: null });
      }
    } catch {
      /* best-effort; keep playing */
    } finally {
      if (restoreVolume !== null) await this.spotify.setVolume(restoreVolume).catch(() => {});
      this.busy = false;
    }
  }

  /**
   * Closed-loop correction: compare where Spotify actually is with where the room
   * is, optionally learn from the error, and seek if it's beyond the deadband.
   * - learn "start": right after a fresh play, the error is start-up latency.
   * - learn "seek":  right after a corrective seek, the error is seek latency.
   */
  private async correctDrift(
    gen: number,
    opts: { learn: DriftLearn; force?: boolean }
  ): Promise<void> {
    const cur = this.current;
    if (!this.alive(gen) || !cur) return;
    const state = await this.spotify.getState();
    if (
      !this.alive(gen) ||
      this.current !== cur ||
      !state ||
      state.paused ||
      !isSameTrack(state.trackIds, cur.trackId)
    ) {
      return;
    }

    const drift = driftMs({
      anchor: cur.anchor,
      reportedPositionMs: state.positionMs,
      reportedAtPerf: state.perfTimestamp,
      nowPerf: performance.now(),
      paused: false,
      userTrimMs: this.effectiveTrimMs(),
    });
    this.cb.onDrift?.(drift);

    const rate = this.settings.latencyLearnRate;
    if (opts.learn === "start") {
      this.startLatencyMs = clamp(this.startLatencyMs + drift * rate, 0, 3000);
      saveNumber(START_LATENCY_KEY, this.startLatencyMs);
    } else if (opts.learn === "seek") {
      this.seekLatencyMs = clamp(this.seekLatencyMs + drift * rate, 0, 2000);
      saveNumber(SEEK_LATENCY_KEY, this.seekLatencyMs);
    }

    if (!opts.force && Math.abs(drift) <= this.settings.driftDeadbandMs) return;

    const seek = targetSeekMs({
      anchor: cur.anchor,
      nowPerf: performance.now(),
      startLatencyMs: this.seekLatencyMs,
      userTrimMs: this.effectiveTrimMs(),
    });
    await this.spotify.seek(seek);
    this.lastDriftCheck = performance.now();

    // Measure the result once the seek has settled, to learn the seek latency.
    if (opts.learn !== "seek") {
      this.later(gen, FIRST_DRIFT_CHECK_MS, () =>
        this.runExclusive(() => this.correctDrift(gen, { learn: "seek" }))
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Manual trim plus (optionally) the output device's latency, e.g. Bluetooth. */
  private effectiveTrimMs(): number {
    const auto = this.settings.autoOutputLatency ? this.capture.outputLatencyMs : 0;
    return this.userTrimMs + auto;
  }

  private alive(gen: number): boolean {
    return gen === this.session && this.abort !== null;
  }

  private setPhase(phase: SyncPhase, detail?: string): void {
    this.phase = phase;
    this.cb.onPhase(phase, detail);
  }

  private fail(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    return this.stop({ phase: "error", detail: message });
  }

  /** setTimeout bound to the session: cleared on stop, ignored if stale. */
  private later(gen: number, ms: number, fn: () => unknown): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.alive(gen)) return;
      Promise.resolve(fn()).catch(() => {});
    }, ms);
    this.timers.add(timer);
  }

  /** Run a Spotify-touching job unless another one is in progress. */
  private async runExclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch {
      /* best-effort */
    } finally {
      this.busy = false;
    }
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock || this.wakeLock) return;
      this.wakeLock = await nav.wakeLock.request("screen");
    } catch {
      /* not supported / not allowed — keep going without it */
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

function isAbort(err: unknown): boolean {
  return (err as DOMException)?.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function loadNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const n = Number(window.localStorage.getItem(key) ?? NaN);
  return Number.isFinite(n) ? n : fallback;
}

function saveNumber(key: string, value: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(Math.round(value)));
}
