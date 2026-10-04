// Client-side sync tuning, persisted in localStorage. These knobs control the
// time-alignment behavior and live in the browser (no server round-trip needed).

export interface SyncSettings {
  /** How long the first recognition clip is recorded for (ms). */
  clipDurationMs: number;
  /** Initial guess for Spotify start-up latency before any learning (ms). */
  defaultStartLatencyMs: number;
  /** Drift below this is left alone to avoid audible re-seeks (ms). */
  driftDeadbandMs: number;
  /** 0..1 — how strongly each drift measurement updates the learned latencies. */
  latencyLearnRate: number;
  /** When a song ends, listen for the next one and sync it automatically. */
  autoFollow: boolean;
  /** Clip length when listening for the next song (shorter = shorter gap). */
  followClipDurationMs: number;
  /**
   * Re-identify the room every N seconds while playing, to catch a DJ cutting to
   * a new song early and to re-align against the real room audio. 0 = off.
   */
  changeCheckIntervalSec: number;
  /** Mute Spotify during those checks (needed if the mic can hear your speakers). */
  muteDuringCheck: boolean;
  /** Add the browser-reported output latency (e.g. Bluetooth) automatically. */
  autoOutputLatency: boolean;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  clipDurationMs: 6000,
  defaultStartLatencyMs: 400,
  driftDeadbandMs: 60,
  latencyLearnRate: 0.5,
  autoFollow: true,
  followClipDurationMs: 4000,
  changeCheckIntervalSec: 0,
  muteDuringCheck: true,
  autoOutputLatency: true,
};

const STORAGE_KEY = "s2m_sync_settings";

export function loadSyncSettings(): SyncSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SYNC_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SYNC_SETTINGS };
    const parsed = JSON.parse(raw);
    return sanitize({ ...DEFAULT_SYNC_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SYNC_SETTINGS };
  }
}

export function saveSyncSettings(settings: SyncSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
}

/** Clamp to sane ranges so a bad value can't break playback. */
function sanitize(s: SyncSettings): SyncSettings {
  const interval = clamp(s.changeCheckIntervalSec, 0, 600);
  return {
    clipDurationMs: clamp(s.clipDurationMs, 2000, 15000),
    defaultStartLatencyMs: clamp(s.defaultStartLatencyMs, 0, 3000),
    driftDeadbandMs: clamp(s.driftDeadbandMs, 0, 1000),
    latencyLearnRate: clamp(s.latencyLearnRate, 0, 1),
    autoFollow: Boolean(s.autoFollow),
    followClipDurationMs: clamp(s.followClipDurationMs, 2000, 15000),
    // A check needs a clip plus recognition time; anything under 20s is noise.
    changeCheckIntervalSec: interval > 0 ? Math.max(20, interval) : 0,
    muteDuringCheck: Boolean(s.muteDuringCheck),
    autoOutputLatency: Boolean(s.autoOutputLatency),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
