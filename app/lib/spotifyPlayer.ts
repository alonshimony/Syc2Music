// Thin wrapper around the Spotify Web Playback SDK: loads the script, creates a
// player, registers it as a device, and exposes the operations the sync controller
// needs (start a track at a position, seek, volume, and read the current state with
// a reliable live position so we can measure drift and detect the track ending).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { livePlayerPosition, type PlayerSnapshot } from "./followLogic";

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export interface PlaybackState extends PlayerSnapshot {
  /** performance.now() at which positionMs was true. */
  perfTimestamp: number;
}

let sdkLoading: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (sdkLoading) return sdkLoading;

  sdkLoading = new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Spotify SDK"));
    document.body.appendChild(script);
  });
  return sdkLoading;
}

function toSnapshot(state: any): Omit<PlaybackState, "perfTimestamp"> {
  const track = state.track_window?.current_track;
  const trackIds = [track?.id, track?.linked_from?.id].filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  return {
    paused: Boolean(state.paused),
    positionMs: Number(state.position) || 0,
    durationMs: Number(state.duration ?? track?.duration_ms) || 0,
    trackIds,
  };
}

export class SpotifyController {
  private player: any = null;
  private deviceId: string | null = null;
  private getToken: () => Promise<string>;

  /** Called when the browser refuses to start audio (autoplay policy). */
  onAutoplayBlocked?: () => void;

  constructor(getToken: () => Promise<string>) {
    this.getToken = getToken;
  }

  /** Load the SDK, create the player, and wait until our device is ready. */
  async connect(): Promise<void> {
    await loadSdk();
    if (this.player) return;

    this.player = new window.Spotify.Player({
      name: "Sync2Music",
      getOAuthToken: (cb: (t: string) => void) => {
        this.getToken().then(cb).catch(() => cb(""));
      },
      volume: 1.0,
    });

    const ready = new Promise<void>((resolve, reject) => {
      this.player.addListener("ready", ({ device_id }: any) => {
        this.deviceId = device_id;
        resolve();
      });
      this.player.addListener("not_ready", () => {
        this.deviceId = null;
      });
      this.player.addListener("initialization_error", ({ message }: any) =>
        reject(new Error(message))
      );
      this.player.addListener("authentication_error", ({ message }: any) =>
        reject(new Error("Spotify auth error: " + message))
      );
      this.player.addListener("account_error", () =>
        reject(new Error("Spotify Premium is required for playback."))
      );
      this.player.addListener("autoplay_failed", () => this.onAutoplayBlocked?.());
    });

    const connected = await this.player.connect();
    if (!connected) throw new Error("Spotify player failed to connect.");
    await ready;
  }

  /** Required by browsers: must be called from a user gesture before audio plays. */
  async activate(): Promise<void> {
    if (this.player?.activateElement) {
      try {
        await this.player.activateElement();
      } catch {
        /* best-effort; some browsers resolve audio later */
      }
    }
  }

  /**
   * Start playing `trackId` at `positionMs` on our device. Uses the Web API
   * (start/transfer playback) because the SDK has no "play this uri" method.
   * A single-track `uris` list means Spotify stops at the end of the song;
   * the sync controller detects that (and any autoplay pick) itself.
   */
  async startTrackAt(trackId: string, positionMs: number): Promise<void> {
    if (!this.deviceId) throw new Error("Spotify device not ready.");
    const token = await this.getToken();
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uris: [`spotify:track:${trackId}`],
          position_ms: Math.max(0, Math.round(positionMs)),
        }),
      }
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`Spotify play failed (${res.status}): ${text}`);
    }
  }

  /** Seek within the currently playing track. */
  async seek(positionMs: number): Promise<void> {
    if (!this.player) throw new Error("Spotify player not connected.");
    await this.player.seek(Math.max(0, Math.round(positionMs)));
  }

  async pause(): Promise<void> {
    await this.player?.pause();
  }

  async getVolume(): Promise<number> {
    const v = await this.player?.getVolume();
    return typeof v === "number" ? v : 1;
  }

  async setVolume(volume: number): Promise<void> {
    await this.player?.setVolume(Math.max(0, Math.min(1, volume)));
  }

  /** One cheap read of the local playback state (no network). */
  async getSnapshot(): Promise<PlaybackState | null> {
    if (!this.player) return null;
    const state = await this.player.getCurrentState();
    if (!state) return null;
    return { ...toSnapshot(state), perfTimestamp: performance.now() };
  }

  /**
   * Playback state with an accurate live position. Takes two reads ~200ms
   * apart (see livePlayerPosition) because, depending on the SDK, `position`
   * may be frozen at the last state event rather than live.
   */
  async getState(): Promise<PlaybackState | null> {
    if (!this.player) return null;
    const first = await this.player.getCurrentState();
    const firstPerf = performance.now();
    if (!first) return null;
    await new Promise((r) => setTimeout(r, 200));
    const second = await this.player.getCurrentState();
    const secondPerf = performance.now();
    if (!second) return null;

    const live = livePlayerPosition(
      {
        positionMs: first.position,
        perf: firstPerf,
        epochTimestamp: first.timestamp,
        paused: first.paused,
      },
      {
        positionMs: second.position,
        perf: secondPerf,
        epochTimestamp: second.timestamp,
        paused: second.paused,
      },
      Date.now()
    );
    return { ...toSnapshot(second), positionMs: live.positionMs, perfTimestamp: live.perf };
  }

  async disconnect(): Promise<void> {
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
  }
}
