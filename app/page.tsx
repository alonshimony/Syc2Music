"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SyncController } from "./lib/syncController";
import type { IdentifyResult, SyncPhase } from "./lib/types";

const PHASE_LABEL: Record<SyncPhase, string> = {
  idle: "Ready",
  listening: "Listening…",
  identifying: "Identifying…",
  syncing: "Syncing…",
  playing: "Playing — in sync",
  no_match: "No match found",
  error: "Error",
};

export default function Home() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [detail, setDetail] = useState<string>("");
  const [track, setTrack] = useState<IdentifyResult | null>(null);
  const [trimMs, setTrimMs] = useState(0);
  const [drift, setDrift] = useState<number | null>(null);

  const controllerRef = useRef<SyncController | null>(null);
  const tokenCache = useRef<{ token: string; expiresAt: number } | null>(null);

  // --- Spotify token plumbing -------------------------------------------------
  const getToken = useCallback(async (): Promise<string> => {
    const cached = tokenCache.current;
    if (cached && cached.expiresAt - Date.now() > 10_000) return cached.token;

    const res = await fetch("/api/spotify/token");
    if (!res.ok) {
      setConnected(false);
      throw new Error("Not connected to Spotify.");
    }
    const data = await res.json();
    tokenCache.current = {
      token: data.accessToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
    };
    return data.accessToken;
  }, []);

  // Detect connection state on load (and after OAuth redirect).
  useEffect(() => {
    fetch("/api/spotify/token")
      .then((r) => setConnected(r.ok))
      .catch(() => setConnected(false));

    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_error")) {
      setPhase("error");
      setDetail(`Spotify connection failed: ${params.get("spotify_error")}`);
    }
    if (params.has("spotify")) {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const ensureController = useCallback((): SyncController => {
    if (!controllerRef.current) {
      controllerRef.current = new SyncController(getToken, {
        onPhase: (p, d) => {
          setPhase(p);
          setDetail(d ?? "");
        },
        onTrack: (t) => setTrack(t),
        onDrift: (d) => setDrift(Math.round(d)),
      });
    }
    return controllerRef.current;
  }, [getToken]);

  // --- Actions ----------------------------------------------------------------
  const handleListen = async () => {
    setTrack(null);
    setDrift(null);
    const controller = ensureController();
    controller.setUserTrimMs(trimMs);
    try {
      await controller.connectSpotify();
    } catch (e: any) {
      setPhase("error");
      setDetail(e?.message ?? "Could not connect Spotify player.");
      return;
    }
    await controller.listenAndSync();
  };

  const handleTrim = (value: number) => {
    setTrimMs(value);
    controllerRef.current?.setUserTrimMs(value);
  };

  const handleNudge = (delta: number) => {
    controllerRef.current?.nudge(delta).catch(() => {});
    setTrimMs((t) => t + delta);
  };

  const handleStop = () => {
    controllerRef.current?.stop().catch(() => {});
    setPhase("idle");
  };

  const busy = phase === "listening" || phase === "identifying" || phase === "syncing";
  const dotClass =
    phase === "error" || phase === "no_match"
      ? "dot error"
      : busy || phase === "playing"
        ? "dot live"
        : "dot";

  return (
    <main className="wrap">
      <div className="row between">
        <h1>🎧 Sync2Music</h1>
        <Link href="/settings">
          <button className="btn-ghost">⚙️ Settings</button>
        </Link>
      </div>
      <p className="subtitle">
        Hears the music playing around you, identifies it, and plays the same song
        from the same spot on Spotify — lined up with the live audio.
      </p>

      {/* Connection */}
      <div className="panel">
        <div className="row between">
          <span className="status">
            <span className={connected ? "badge ok" : "badge"}>
              {connected === null
                ? "Checking…"
                : connected
                  ? "Spotify connected"
                  : "Spotify not connected"}
            </span>
          </span>
          {!connected && (
            <a href="/api/spotify/login">
              <button className="btn-spotify">Connect Spotify</button>
            </a>
          )}
        </div>
        {!connected && connected !== null && (
          <p className="hint" style={{ marginTop: 12 }}>
            Spotify <strong>Premium</strong> is required to play full tracks in the
            browser.
          </p>
        )}
      </div>

      {/* Main control */}
      <div className="panel">
        <button
          className="btn-primary"
          onClick={handleListen}
          disabled={!connected || busy}
        >
          {busy ? PHASE_LABEL[phase] : "🎙️ Listen & Sync"}
        </button>

        <div className="row" style={{ marginTop: 14 }}>
          <span className="status">
            <span className={dotClass} />
            {PHASE_LABEL[phase]}
          </span>
        </div>
        {detail && <p className="error-text" style={{ marginTop: 8 }}>{detail}</p>}
      </div>

      {/* Now playing */}
      {track && (
        <div className="panel">
          <div className="track">
            <span className="title">{track.title}</span>
            <span className="artist">{track.artist}</span>
          </div>
          <div className="meta">
            {track.album ? `${track.album} · ` : ""}
            matched at {(track.playOffsetMs / 1000).toFixed(1)}s into the track
            {drift !== null && ` · drift ${drift > 0 ? "+" : ""}${drift}ms`}
          </div>
        </div>
      )}

      {/* Calibration */}
      <div className="panel">
        <label className="field">
          Offset trim: <span className="trim-value">{trimMs > 0 ? "+" : ""}{trimMs} ms</span>{" "}
          {trimMs === 0 ? "(no adjustment)" : trimMs > 0 ? "(Spotify later)" : "(Spotify earlier)"}
        </label>
        <input
          type="range"
          min={-2000}
          max={2000}
          step={20}
          value={trimMs}
          onChange={(e) => handleTrim(Number(e.target.value))}
        />
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <button className="btn-ghost" onClick={() => handleNudge(-100)} disabled={phase !== "playing"}>
            −100 ms
          </button>
          <button className="btn-ghost" onClick={() => handleNudge(100)} disabled={phase !== "playing"}>
            +100 ms
          </button>
          <button
            className="btn-ghost"
            onClick={() => controllerRef.current?.correctDrift().catch(() => {})}
            disabled={phase !== "playing"}
          >
            Re-sync
          </button>
          <button className="btn-ghost" onClick={handleStop} disabled={phase !== "playing"}>
            Stop
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          If Spotify lags behind the room, nudge <strong>+</strong>; if it&apos;s ahead,
          nudge <strong>−</strong>. The app remembers the learned latency for next time.
        </p>
      </div>
    </main>
  );
}
