// Pure, dependency-free sync math. Kept separate from the orchestration so the
// time-alignment logic — the core of the app — can be unit-tested in isolation.
//
// Time domains:
//  - "perf"  : performance.now() milliseconds (monotonic wall clock in the browser).
//  - "song"  : position within the track in ms (what we seek Spotify to).
//
// Anchor: ACRCloud's playOffsetMs is the SONG position at `clipStartPerf` (the PERF
// instant of the first captured sample). Everything else is derived from that.

export interface SyncAnchor {
  playOffsetMs: number;
  clipStartPerf: number;
}

/** Where the live (room) song is, in song-ms, at a given perf instant. */
export function livePositionMs(anchor: SyncAnchor, nowPerf: number): number {
  return anchor.playOffsetMs + (nowPerf - anchor.clipStartPerf);
}

export interface SeekParams {
  anchor: SyncAnchor;
  nowPerf: number;
  /** Measured/estimated delay before Spotify actually starts producing sound. */
  startLatencyMs: number;
  /** Manual user trim for speaker/room/output latency (can be negative). */
  userTrimMs: number;
}

/**
 * Song position to seek to so that, once Spotify actually starts (after
 * startLatencyMs), it lands on the live position. We project the live position
 * forward by the start latency and add the user trim.
 */
export function targetSeekMs({
  anchor,
  nowPerf,
  startLatencyMs,
  userTrimMs,
}: SeekParams): number {
  return Math.max(
    0,
    livePositionMs(anchor, nowPerf) + startLatencyMs + userTrimMs
  );
}

/**
 * Project the SDK's last reported position to `nowPerf` (only meaningful while
 * playing — paused playback does not advance).
 */
export function projectedPlayerPositionMs(
  reportedPositionMs: number,
  reportedAtPerf: number,
  nowPerf: number,
  paused: boolean
): number {
  if (paused) return reportedPositionMs;
  return reportedPositionMs + (nowPerf - reportedAtPerf);
}

/**
 * Residual drift in ms = how far the live song is AHEAD of Spotify right now.
 *   positive  -> Spotify is behind; seek forward and increase startLatency.
 *   negative  -> Spotify is ahead; seek back and decrease startLatency.
 * userTrim is included because the user's perceived alignment already accounts for it.
 */
export function driftMs(params: {
  anchor: SyncAnchor;
  reportedPositionMs: number;
  reportedAtPerf: number;
  nowPerf: number;
  paused: boolean;
  userTrimMs: number;
}): number {
  const live =
    livePositionMs(params.anchor, params.nowPerf) + params.userTrimMs;
  const player = projectedPlayerPositionMs(
    params.reportedPositionMs,
    params.reportedAtPerf,
    params.nowPerf,
    params.paused
  );
  return live - player;
}
