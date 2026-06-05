// Shared types between the client sync controller and the server route handlers.

/** Result of an ACRCloud identification, normalized for the client. */
export interface IdentifyResult {
  /** Spotify track id, present when ACRCloud has Spotify metadata for the match. */
  spotifyTrackId: string | null;
  title: string;
  artist: string;
  album: string | null;
  /**
   * Position (ms) within the track that corresponds to the START of the audio
   * clip we sent. This is our sync anchor.
   */
  playOffsetMs: number;
  /** Track duration in ms when ACRCloud reports it. */
  durationMs: number | null;
}

/** Shape returned by POST /api/identify. */
export type IdentifyResponse =
  | { status: "ok"; result: IdentifyResult }
  | { status: "no_match" }
  | { status: "error"; message: string };

/** State machine phases surfaced to the UI. */
export type SyncPhase =
  | "idle"
  | "listening"
  | "identifying"
  | "syncing"
  | "playing"
  | "no_match"
  | "error";
