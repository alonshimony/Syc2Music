// Thin wrapper around the Spotify Web Playback SDK: loads the script, creates a
// player, registers it as a device, and exposes the operations the sync controller
// needs (start a track at a position, seek, and read the current state with its
// timestamp so we can measure real playback latency / drift).

/* eslint-disable @typescript-eslint/no-explicit-any */

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export interface PlaybackState {
  /** Position in ms reported by the SDK. */
  positionMs: number;
  /** performance.now()-domain timestamp the position was sampled. */
  perfTimestamp: number;
  paused: boolean;
  trackId: string | null;
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

export class SpotifyController {
  private player: any = null;
  private deviceId: string | null = null;
  private getToken: () => Promise<string>;

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
      this.player.addListener("initialization_error", ({ message }: any) =>
        reject(new Error(message))
      );
      this.player.addListener("authentication_error", ({ message }: any) =>
        reject(new Error("Spotify auth error: " + message))
      );
      this.player.addListener("account_error", () =>
        reject(new Error("Spotify Premium is required for playback."))
      );
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

  async resume(): Promise<void> {
    await this.player?.resume();
  }

  async pause(): Promise<void> {
    await this.player?.pause();
  }

  /** Snapshot current position with a tight performance.now() timestamp. */
  async getState(): Promise<PlaybackState | null> {
    if (!this.player) return null;
    const state = await this.player.getCurrentState();
    if (!state) return null;
    return {
      positionMs: state.position,
      perfTimestamp: performance.now(),
      paused: state.paused,
      trackId: state.track_window?.current_track?.id ?? null,
    };
  }

  async disconnect(): Promise<void> {
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
  }
}
