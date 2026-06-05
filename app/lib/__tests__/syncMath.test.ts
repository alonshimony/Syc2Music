import { describe, it, expect } from "vitest";
import {
  livePositionMs,
  targetSeekMs,
  projectedPlayerPositionMs,
  driftMs,
  type SyncAnchor,
} from "../syncMath";

const anchor: SyncAnchor = { playOffsetMs: 30_000, clipStartPerf: 1_000 };

describe("livePositionMs", () => {
  it("advances the song position by elapsed perf time", () => {
    // 2s after clip start, the song has moved 2s past the matched offset.
    expect(livePositionMs(anchor, 3_000)).toBe(32_000);
  });
});

describe("targetSeekMs", () => {
  it("projects live position forward by start latency + user trim", () => {
    const seek = targetSeekMs({
      anchor,
      nowPerf: 3_000, // live = 32_000
      startLatencyMs: 400,
      userTrimMs: 100,
    });
    expect(seek).toBe(32_500);
  });

  it("never returns a negative seek", () => {
    const seek = targetSeekMs({
      anchor: { playOffsetMs: 0, clipStartPerf: 10_000 },
      nowPerf: 10_000,
      startLatencyMs: 0,
      userTrimMs: -5_000,
    });
    expect(seek).toBe(0);
  });
});

describe("projectedPlayerPositionMs", () => {
  it("advances while playing", () => {
    expect(projectedPlayerPositionMs(10_000, 1_000, 1_500, false)).toBe(10_500);
  });
  it("holds while paused", () => {
    expect(projectedPlayerPositionMs(10_000, 1_000, 1_500, true)).toBe(10_000);
  });
});

describe("driftMs", () => {
  it("is positive when Spotify is behind the live song", () => {
    // Live at now=3000 is 32_000. Spotify reported 31_000 at perf 3000 -> behind by 1000.
    const drift = driftMs({
      anchor,
      reportedPositionMs: 31_000,
      reportedAtPerf: 3_000,
      nowPerf: 3_000,
      paused: false,
      userTrimMs: 0,
    });
    expect(drift).toBe(1_000);
  });

  it("is ~zero when perfectly aligned, accounting for projection", () => {
    // Spotify reported 31_500 at perf 2500; by now=3000 it has advanced to 32_000 = live.
    const drift = driftMs({
      anchor,
      reportedPositionMs: 31_500,
      reportedAtPerf: 2_500,
      nowPerf: 3_000,
      paused: false,
      userTrimMs: 0,
    });
    expect(drift).toBe(0);
  });

  it("includes user trim in the live target", () => {
    const drift = driftMs({
      anchor,
      reportedPositionMs: 32_000,
      reportedAtPerf: 3_000,
      nowPerf: 3_000,
      paused: false,
      userTrimMs: 250,
    });
    expect(drift).toBe(250);
  });
});
