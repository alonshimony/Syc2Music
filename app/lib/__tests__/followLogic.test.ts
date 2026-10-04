import { describe, it, expect } from "vitest";
import {
  classifyPlayback,
  decideAfterListen,
  isSameTrack,
  livePlayerPosition,
  type PlayerSnapshot,
} from "../followLogic";

const OURS = "track-ours";
const snap = (over: Partial<PlayerSnapshot>): PlayerSnapshot => ({
  paused: false,
  positionMs: 60_000,
  durationMs: 200_000,
  trackIds: [OURS],
  ...over,
});
const seen = { sawOurTrackPlaying: true, lastRemainingMs: 140_000 };

describe("isSameTrack", () => {
  it("matches the relinked (linked_from) id too", () => {
    expect(isSameTrack(["market-id", OURS], OURS)).toBe(true);
    expect(isSameTrack(["other"], OURS)).toBe(false);
    expect(isSameTrack([OURS], null)).toBe(false);
  });
});

describe("classifyPlayback", () => {
  it("is playing while our track plays", () => {
    expect(classifyPlayback(snap({}), OURS, seen)).toBe("playing");
  });

  it("is starting before our track first appears", () => {
    const fresh = { sawOurTrackPlaying: false, lastRemainingMs: null };
    expect(classifyPlayback(snap({ trackIds: ["previous"] }), OURS, fresh)).toBe("starting");
    expect(classifyPlayback(null, OURS, fresh)).toBe("starting");
  });

  it("detects Spotify autoplay switching to another track", () => {
    expect(classifyPlayback(snap({ trackIds: ["autoplay-pick"] }), OURS, seen)).toBe(
      "switched"
    );
  });

  it("detects the end when paused at the very end", () => {
    expect(
      classifyPlayback(snap({ paused: true, positionMs: 199_500 }), OURS, seen)
    ).toBe("ended");
  });

  it("detects the end when it resets to 0 right after being near the end", () => {
    const nearEnd = { sawOurTrackPlaying: true, lastRemainingMs: 1_200 };
    expect(classifyPlayback(snap({ paused: true, positionMs: 0 }), OURS, nearEnd)).toBe(
      "ended"
    );
  });

  it("treats a mid-song pause as an external pause", () => {
    expect(classifyPlayback(snap({ paused: true }), OURS, seen)).toBe("external_pause");
  });

  it("treats a missing state as lost once we were playing", () => {
    expect(classifyPlayback(null, OURS, seen)).toBe("lost");
  });
});

describe("decideAfterListen", () => {
  const prev = { trackId: OURS, durationMs: 200_000 };

  it("switches to a different song", () => {
    expect(decideAfterListen({ spotifyTrackId: "next", playOffsetMs: 3_000 }, prev, 1_000)).toBe(
      "switch"
    );
  });

  it("switches when there was no previous song", () => {
    expect(decideAfterListen({ spotifyTrackId: OURS, playOffsetMs: 3_000 }, null, 1_000)).toBe(
      "switch"
    );
  });

  it("waits when the room is still finishing a longer version of the same song", () => {
    expect(
      decideAfterListen({ spotifyTrackId: OURS, playOffsetMs: 199_000 }, prev, 1_500)
    ).toBe("wait");
  });

  it("re-syncs the same song when well inside it", () => {
    expect(
      decideAfterListen({ spotifyTrackId: OURS, playOffsetMs: 90_000 }, prev, 1_500)
    ).toBe("resync_same");
  });
});

describe("livePlayerPosition", () => {
  it("uses the position directly when it is live (advances between reads)", () => {
    const pos = livePlayerPosition(
      { positionMs: 10_000, perf: 1_000, paused: false },
      { positionMs: 10_250, perf: 1_250, paused: false },
      0
    );
    expect(pos).toEqual({ positionMs: 10_250, perf: 1_250 });
  });

  it("extrapolates from the timestamp when the position is frozen", () => {
    const pos = livePlayerPosition(
      { positionMs: 10_000, perf: 1_000, paused: false, epochTimestamp: 50_000 },
      { positionMs: 10_000, perf: 1_250, paused: false, epochTimestamp: 50_000 },
      53_000
    );
    expect(pos).toEqual({ positionMs: 13_000, perf: 1_250 });
  });

  it("does not advance a paused player", () => {
    const pos = livePlayerPosition(
      { positionMs: 10_000, perf: 1_000, paused: true, epochTimestamp: 50_000 },
      { positionMs: 10_000, perf: 1_250, paused: true, epochTimestamp: 50_000 },
      53_000
    );
    expect(pos).toEqual({ positionMs: 10_000, perf: 1_250 });
  });
});
