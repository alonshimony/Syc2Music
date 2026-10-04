"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SyncController } from "./lib/syncController";
import { getCookie, setCookie } from "./lib/clientCookies";
import { loadSyncSettings } from "./lib/syncSettings";
import type { IdentifyResult, SyncPhase } from "./lib/types";

const OFFSET_COOKIE = "s2m_offset_ms";

const PHASE_LABEL: Record<SyncPhase, string> = {
  idle: "Ready",
  listening: "Listening…",
  identifying: "Identifying…",
  syncing: "Syncing…",
  playing: "Playing — in sync",
  waiting: "Waiting for the next song…",
  no_match: "No match found",
  error: "Error",
};

/** Phases during which a session is running (Stop is meaningful). */
const ACTIVE_PHASES: SyncPhase[] = ["listening", "identifying", "syncing", "playing", "waiting"];

export default function Home() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [detail, setDetail] = useState<string>("");
  const [track, setTrack] = useState<IdentifyResult | null>(null);
  const [trimMs, setTrimMs] = useState(0);
  const [drift, setDrift] = useState<number | null>(null);
  const [credStatus, setCredStatus] = useState<{ acr: boolean; spotify: boolean } | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);

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

    // Read back what the server actually sees, so it's obvious whether saved
    // credentials are reaching it (the cookie is being sent) vs. not.
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings;
        setCredStatus({
          acr: s.acrHost?.isSet && s.acrAccessKey?.isSet && s.acrAccessSecret?.isSet,
          spotify: s.spotifyClientId?.isSet && s.spotifyClientSecret?.isSet,
        });
      })
      .catch(() => setCredStatus(null));

    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_error")) {
      setPhase("error");
      setDetail(`Spotify connection failed: ${params.get("spotify_error")}`);
    }
    if (params.has("spotify")) {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Restore the saved offset trim, and read whether follow mode is on.
  useEffect(() => {
    const saved = getCookie(OFFSET_COOKIE);
    if (saved !== null && Number.isFinite(Number(saved))) {
      setTrimMs(Number(saved));
    }
    setAutoFollow(loadSyncSettings().autoFollow);
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

  // Warm up the Spotify player once connected so the click handler only has to
  // run the fast activate() within the user-gesture window.
  useEffect(() => {
    if (connected) {
      ensureController().connectSpotify().catch(() => {});
    }
  }, [connected, ensureController]);

  // --- Actions ----------------------------------------------------------------
  const handleListen = async () => {
    setTrack(null);
    setDrift(null);
    const controller = ensureController();
    controller.setUserTrimMs(trimMs);
    try {
      await controller.connectSpotify();
      // Unlock browser audio inside this click gesture, BEFORE the ~6s record +
      // identify pipeline. Otherwise the gesture expires and autoplay is blocked,
      // so Spotify reports "playing" but nothing is audible.
      await controller.prepareAudio();
    } catch (e: any) {
      setPhase("error");
      setDetail(e?.message ?? "Could not connect Spotify player.");
      return;
    }
    // start() stops any running session (and our playback, so it doesn't bleed
    // into the mic) before listening again.
    await controller.start();
  };

  // Every offset change goes through here: saved to the cookie and handed to the
  // controller, which re-aligns playback to the new offset right away.
  const handleTrim = (value: number) => {
    const rounded = Math.round(value);
    setTrimMs(rounded);
    setCookie(OFFSET_COOKIE, String(rounded));
    controllerRef.current?.setUserTrimMs(rounded);
  };

  const handleNudge = (delta: number) => handleTrim(trimMs + delta);

  const handleStop = () => {
    if (controllerRef.current) controllerRef.current.stop().catch(() => {});
    else setPhase("idle");
  };

  const active = ACTIVE_PHASES.includes(phase);
  const isError = phase === "error" || phase === "no_match";
  const dotClass = isError ? "dot error" : active ? "dot live" : "dot";

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

        {credStatus && (!credStatus.acr || !credStatus.spotify) && (
          <p className="hint" style={{ marginTop: 12 }}>
            Server sees:{" "}
            <span className={credStatus.spotify ? "badge ok" : "badge"}>
              Spotify creds {credStatus.spotify ? "✓" : "missing"}
            </span>{" "}
            <span className={credStatus.acr ? "badge ok" : "badge"}>
              ACRCloud creds {credStatus.acr ? "✓" : "missing"}
            </span>
            <br />
            If these show “missing” right after you saved them on{" "}
            <Link href="/settings">Settings</Link>, your credentials cookie isn’t
            reaching the server — make sure you saved on this same URL and that the
            browser allows cookies.
          </p>
        )}
      </div>

      {/* Main control */}
      <div className="panel">
        <button className="btn-primary" onClick={handleListen} disabled={!connected}>
          {active ? "🔄 Re-sync" : "🎙️ Listen & Sync"}
        </button>

        {active && (
          <button
            className="btn-primary"
            onClick={handleStop}
            style={{ marginTop: 10, background: "var(--danger)", color: "#2b0606" }}
          >
            ⏹ Stop
          </button>
        )}

        <div className="row between" style={{ marginTop: 14 }}>
          <span className="status">
            <span className={dotClass} />
            {PHASE_LABEL[phase]}
          </span>
          <Link href="/settings" className="badge" style={{ textDecoration: "none" }}>
            Auto-follow {autoFollow ? "on" : "off"}
          </Link>
        </div>
        {detail && (
          <p className={isError ? "error-text" : "hint"} style={{ marginTop: 8 }}>
            {detail}
          </p>
        )}
      </div>

      {/* Now playing */}
      {track && (
        <div className="panel">
          <div className="meta" style={{ marginTop: 0, marginBottom: 6 }}>
            {phase === "playing" || phase === "syncing" ? "Now playing" : "Last song"}
          </div>
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
            onClick={() => controllerRef.current?.realign().catch(() => {})}
            disabled={phase !== "playing"}
          >
            Re-align
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          If Spotify lags behind the room, nudge <strong>+</strong>; if it&apos;s ahead,
          nudge <strong>−</strong>. Changes apply immediately and are saved for next
          time; the app also learns Spotify&apos;s start-up and seek delays on its own.
        </p>
      </div>
    </main>
  );
}
