// Pure decision logic for "follow mode": detecting when our Spotify track ended
// (or was replaced by Spotify autoplay / another device), deciding what to do with
// a fresh recognition result at a song boundary, and reading a reliable live
// position from the Web Playback SDK. Dependency-free so it can be unit-tested.

/** Minimal view of the Web Playback SDK state that the follow logic needs. */
export interface PlayerSnapshot {
  paused: boolean;
  positionMs: number;
  durationMs: number;
  /** Current track id plus its `linked_from` id (Spotify track relinking). */
  trackIds: string[];
}

/** Within this many ms of the end, a paused track counts as "finished". */
const END_EPSILON_MS = 1500;
/** If we last saw the track this close to its end, a reset to 0 means it finished. */
const END_WINDOW_MS = 5000;

/**
 * Same recording? Spotify may relink a track to a market-specific id, so the
 * SDK can report a different `id` with the requested one in `linked_from`.
 */
export function isSameTrack(trackIds: string[], trackId: string | null): boolean {
  return trackId !== null && trackIds.includes(trackId);
}

export function remainingMs(durationMs: number, positionMs: number): number {
  return Math.max(0, durationMs - positionMs);
}

export type PlaybackStatus =
  /** Our track hasn't shown up in the player yet. */
  | "starting"
  | "playing"
  /** Our track reached its end. */
  | "ended"
  /** Something else is playing now (Spotify autoplay, or a skip from another app). */
  | "switched"
  /** Paused mid-song by someone else (e.g. the Spotify app). */
  | "external_pause"
  /** No local playback state: playback moved to another device. */
  | "lost";

export function classifyPlayback(
  snap: PlayerSnapshot | null,
  ourTrackId: string,
  ctx: { sawOurTrackPlaying: boolean; lastRemainingMs: number | null }
): PlaybackStatus {
  if (!snap) return ctx.sawOurTrackPlaying ? "lost" : "starting";

  if (!isSameTrack(snap.trackIds, ourTrackId)) {
    // Right after we request a new track the SDK can still report the old one.
    return ctx.sawOurTrackPlaying ? "switched" : "starting";
  }

  if (!snap.paused) return "playing";

  const nearEnd =
    snap.durationMs > 0 && remainingMs(snap.durationMs, snap.positionMs) < END_EPSILON_MS;
  const resetAfterEnd =
    snap.positionMs < END_EPSILON_MS &&
    ctx.lastRemainingMs !== null &&
    ctx.lastRemainingMs < END_WINDOW_MS;
  if (nearEnd || resetAfterEnd) return "ended";

  return ctx.sawOurTrackPlaying ? "external_pause" : "starting";
}

export type FollowDecision =
  /** A different song is playing in the room: start it. */
  | "switch"
  /** Same song, still well inside it: re-sync to it. */
  | "resync_same"
  /** Same song, but the room is past the end of our (shorter) version: wait. */
  | "wait";

/**
 * After re-listening at a song boundary, decide what to do with the result.
 * The room's version can run longer than the Spotify track (album vs radio
 * edit, outro), so recognizing the song that just ended is common.
 */
export function decideAfterListen(
  result: { spotifyTrackId: string; playOffsetMs: number },
  previous: { trackId: string; durationMs: number } | null,
  elapsedSinceClipStartMs: number
): FollowDecision {
  if (!previous || result.spotifyTrackId !== previous.trackId) return "switch";

  const livePos = result.playOffsetMs + elapsedSinceClipStartMs;
  if (previous.durationMs > 0 && livePos > previous.durationMs - 2000) return "wait";
  return "resync_same";
}

export interface StateSample {
  positionMs: number;
  /** performance.now() when this sample was read. */
  perf: number;
  /** The SDK state's own `timestamp` (epoch ms), when it provides one. */
  epochTimestamp?: number;
  paused: boolean;
}

/**
 * Current Spotify position from two state reads taken a short time apart.
 * Depending on SDK version, `position` is either live or frozen at the last
 * state event (with `timestamp` saying when). Two reads tell us which: if the
 * position advanced it is live; otherwise extrapolate from the timestamp.
 */
export function livePlayerPosition(
  first: StateSample,
  second: StateSample,
  nowEpochMs: number
): { positionMs: number; perf: number } {
  if (second.paused) return { positionMs: second.positionMs, perf: second.perf };

  const elapsed = second.perf - first.perf;
  const advanced = second.positionMs - first.positionMs;
  if (elapsed > 0 && advanced > elapsed * 0.5) {
    return { positionMs: second.positionMs, perf: second.perf };
  }

  if (second.epochTimestamp) {
    const age = nowEpochMs - second.epochTimestamp;
    if (age >= 0 && age < 10 * 60 * 1000) {
      return { positionMs: second.positionMs + age, perf: second.perf };
    }
  }
  return { positionMs: second.positionMs, perf: second.perf };
}
