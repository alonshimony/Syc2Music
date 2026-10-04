"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { AppSettings, ConfigSource } from "../lib/serverConfig";
import {
  DEFAULT_SYNC_SETTINGS,
  loadSyncSettings,
  saveSyncSettings,
  type SyncSettings,
} from "../lib/syncSettings";

type FieldKey = keyof AppSettings;

interface FieldDesc {
  value: string;
  isSet: boolean;
  secret: boolean;
  source: ConfigSource;
}

type SettingsDesc = Record<FieldKey, FieldDesc>;

const CRED_FIELDS: { key: FieldKey; label: string; hint?: string; placeholder?: string }[] = [
  { key: "acrHost", label: "ACRCloud host", placeholder: "identify-eu-west-1.acrcloud.com" },
  { key: "acrAccessKey", label: "ACRCloud access key" },
  { key: "acrAccessSecret", label: "ACRCloud access secret" },
  { key: "spotifyClientId", label: "Spotify client ID" },
  { key: "spotifyClientSecret", label: "Spotify client secret" },
  {
    key: "spotifyRedirectUri",
    label: "Spotify redirect URI (optional)",
    hint: "Leave blank to auto-use the address shown below. Whatever value is used must be listed exactly in your Spotify app's Redirect URIs.",
    placeholder: "(auto: this site + /api/spotify/callback)",
  },
];

export default function SettingsPage() {
  const [desc, setDesc] = useState<SettingsDesc | null>(null);
  const [form, setForm] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [credMsg, setCredMsg] = useState("");

  const [sync, setSync] = useState<SyncSettings>(DEFAULT_SYNC_SETTINGS);
  const [syncMsg, setSyncMsg] = useState("");
  const [origin, setOrigin] = useState("");

  // Load server credential config + local sync tuning.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s: SettingsDesc = d.settings;
        setDesc(s);
        const initial: Partial<Record<FieldKey, string>> = {};
        (Object.keys(s) as FieldKey[]).forEach((k) => {
          initial[k] = s[k].secret ? "" : s[k].value;
        });
        setForm(initial);
      })
      .catch(() => setCredMsg("Failed to load settings."));

    setSync(loadSyncSettings());
    setOrigin(window.location.origin);
  }, []);

  const effectiveRedirect =
    (form.spotifyRedirectUri && form.spotifyRedirectUri.trim()) ||
    (origin ? `${origin}/api/spotify/callback` : "");

  const saveCredentials = async () => {
    setSaving(true);
    setCredMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed.");
      setDesc(data.settings);
      // Clear secret inputs again; non-secret inputs reflect saved values.
      const next: Partial<Record<FieldKey, string>> = {};
      (Object.keys(data.settings as SettingsDesc) as FieldKey[]).forEach((k) => {
        next[k] = (data.settings as SettingsDesc)[k].secret
          ? ""
          : (data.settings as SettingsDesc)[k].value;
      });
      setForm(next);
      setCredMsg("Saved.");
    } catch (e: any) {
      setCredMsg(e?.message ?? "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const saveSync = () => {
    saveSyncSettings(sync);
    setSync(loadSyncSettings()); // reflect clamped values
    setSyncMsg("Saved. Takes effect on the next Listen & Sync.");
  };

  const resetSync = () => {
    saveSyncSettings(DEFAULT_SYNC_SETTINGS);
    setSync(DEFAULT_SYNC_SETTINGS);
    setSyncMsg("Reset to defaults.");
  };

  const clearLearnedLatency = () => {
    window.localStorage.removeItem("s2m_start_latency_ms");
    window.localStorage.removeItem("s2m_seek_latency_ms");
    setSyncMsg("Cleared the learned start-up and seek latencies.");
  };

  const sourceBadge = (f: FieldDesc) => {
    if (f.source === "cookie") return <span className="badge ok">saved here</span>;
    if (f.source === "env") return <span className="badge">from .env</span>;
    return <span className="badge">not set</span>;
  };

  return (
    <main className="wrap">
      <div className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>⚙️ Settings</h1>
        <Link href="/">
          <button className="btn-ghost">← Back</button>
        </Link>
      </div>

      {/* Credentials */}
      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Credentials</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Saved to a secure, httpOnly cookie for this browser and take precedence over
          environment variables. Secrets are write-only — they are never sent back to
          the browser.
        </p>

        {CRED_FIELDS.map(({ key, label, hint, placeholder }) => {
          const f = desc?.[key];
          const isSecret = f?.secret;
          return (
            <div key={key} style={{ marginBottom: 16 }}>
              <label className="field" style={{ marginBottom: 6 }}>
                <span className="row between">
                  <span>{label}</span>
                  {f && sourceBadge(f)}
                </span>
              </label>
              <input
                type={isSecret ? "password" : "text"}
                value={form[key] ?? ""}
                placeholder={
                  isSecret && f?.isSet ? "•••••••• (configured — leave blank to keep)" : placeholder
                }
                onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                style={inputStyle}
                autoComplete="off"
              />
              {hint && <p className="hint" style={{ marginTop: 6 }}>{hint}</p>}
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 4 }}>
          <button className="btn-primary" onClick={saveCredentials} disabled={saving} style={{ width: "auto" }}>
            {saving ? "Saving…" : "Save credentials"}
          </button>
          {credMsg && <span className="hint" style={{ marginLeft: 12 }}>{credMsg}</span>}
        </div>

        <div className="panel" style={{ marginTop: 16, marginBottom: 0, background: "var(--panel-2)" }}>
          <label className="field" style={{ marginBottom: 6 }}>
            Add this exact Redirect URI to your Spotify app
          </label>
          <code style={{ wordBreak: "break-all", fontSize: 13 }}>
            {effectiveRedirect || "…"}
          </code>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            In the Spotify Developer Dashboard → your app → <em>Edit settings</em> →
            <em> Redirect URIs</em>, paste the URL above and save. It must match
            character-for-character.
          </p>
        </div>
      </div>

      {/* Sync tuning */}
      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Sync tuning</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Stored in this browser. Controls how alignment is captured and corrected.
        </p>

        <NumberField
          label="Clip duration (ms)"
          hint="How long each recognition recording is. Longer = more reliable matches, slower."
          min={2000}
          max={15000}
          step={500}
          value={sync.clipDurationMs}
          onChange={(v) => setSync((s) => ({ ...s, clipDurationMs: v }))}
        />
        <NumberField
          label="Default start latency (ms)"
          hint="Initial guess for Spotify's start-up delay before the app learns the real value."
          min={0}
          max={3000}
          step={50}
          value={sync.defaultStartLatencyMs}
          onChange={(v) => setSync((s) => ({ ...s, defaultStartLatencyMs: v }))}
        />
        <NumberField
          label="Drift deadband (ms)"
          hint="Drift smaller than this is left alone to avoid audible re-seeks."
          min={0}
          max={1000}
          step={10}
          value={sync.driftDeadbandMs}
          onChange={(v) => setSync((s) => ({ ...s, driftDeadbandMs: v }))}
        />
        <NumberField
          label="Latency learn rate (0–1)"
          hint="How strongly each drift measurement updates the learned latency."
          min={0}
          max={1}
          step={0.05}
          value={sync.latencyLearnRate}
          onChange={(v) => setSync((s) => ({ ...s, latencyLearnRate: v }))}
        />
        <CheckboxField
          label="Auto-compensate output latency"
          hint="Adds the delay your browser reports for the speakers/headphones (Bluetooth can be 150–300 ms) so you don't have to trim it by hand."
          checked={sync.autoOutputLatency}
          onChange={(v) => setSync((s) => ({ ...s, autoOutputLatency: v }))}
        />

        <h3 style={{ fontSize: 15, margin: "20px 0 10px" }}>When the song changes</h3>
        <CheckboxField
          label="Auto-follow the next song"
          hint="When the song ends, pause Spotify (so its Autoplay can't take over), listen to the room, and sync the next song automatically."
          checked={sync.autoFollow}
          onChange={(v) => setSync((s) => ({ ...s, autoFollow: v }))}
        />
        <NumberField
          label="Next-song clip duration (ms)"
          hint="How long to listen at a song change. Shorter = shorter silence between songs; too short and matches get less reliable."
          min={2000}
          max={15000}
          step={500}
          value={sync.followClipDurationMs}
          onChange={(v) => setSync((s) => ({ ...s, followClipDurationMs: v }))}
        />
        <NumberField
          label="Mid-song check every (seconds, 0 = off)"
          hint="Re-identifies the room while playing: catches a DJ cutting to a new song early, and re-aligns against the real room audio. Minimum 20 s."
          min={0}
          max={600}
          step={5}
          value={sync.changeCheckIntervalSec}
          onChange={(v) => setSync((s) => ({ ...s, changeCheckIntervalSec: v }))}
        />
        <CheckboxField
          label="Mute Spotify during mid-song checks"
          hint="Needed when Spotify plays through speakers the mic can hear (otherwise the app hears itself). Turn off if you listen on headphones — then checks are silent to you."
          checked={sync.muteDuringCheck}
          onChange={(v) => setSync((s) => ({ ...s, muteDuringCheck: v }))}
        />

        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={saveSync} style={{ width: "auto" }}>
            Save tuning
          </button>
          <button className="btn-ghost" onClick={resetSync}>Reset defaults</button>
          <button className="btn-ghost" onClick={clearLearnedLatency}>
            Clear learned latency
          </button>
        </div>
        {syncMsg && <p className="hint" style={{ marginTop: 10 }}>{syncMsg}</p>}
      </div>
    </main>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  const id = useId();
  return (
    <div style={{ marginBottom: 16 }}>
      <label className="field" htmlFor={id} style={{ marginBottom: 6 }}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        style={inputStyle}
      />
      {hint && <p className="hint" style={{ marginTop: 6 }}>{hint}</p>}
    </div>
  );
}

function CheckboxField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label className="row" style={{ gap: 10, cursor: "pointer", fontSize: 14 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
        />
        {label}
      </label>
      {hint && <p className="hint" style={{ marginTop: 6, marginLeft: 28 }}>{hint}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  font: "inherit",
};
