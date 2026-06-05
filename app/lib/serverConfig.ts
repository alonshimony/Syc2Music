// Server-side configuration store. Values can come from two places:
//   1. Environment variables (.env.local) — the original mechanism.
//   2. A JSON file written by the in-app Settings page (takes precedence).
//
// This lets the user configure everything from the browser without editing files,
// while still honoring env vars as defaults. The file lives outside version control
// (.data/ is gitignored) and is only ever read/written on the server.

import fs from "fs";
import path from "path";

export interface AppSettings {
  acrHost?: string;
  acrAccessKey?: string;
  acrAccessSecret?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRedirectUri?: string;
}

/** Fields the UI treats as secret — never returned to the browser in clear text. */
export const SECRET_FIELDS: ReadonlyArray<keyof AppSettings> = [
  "acrAccessSecret",
  "spotifyClientSecret",
];

const DATA_DIR = path.join(process.cwd(), ".data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export function readSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AppSettings) : {};
  } catch {
    return {};
  }
}

export function writeSettings(next: AppSettings): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
}

const ENV_KEYS: Record<keyof AppSettings, string> = {
  acrHost: "ACR_HOST",
  acrAccessKey: "ACR_ACCESS_KEY",
  acrAccessSecret: "ACR_ACCESS_SECRET",
  spotifyClientId: "SPOTIFY_CLIENT_ID",
  spotifyClientSecret: "SPOTIFY_CLIENT_SECRET",
  spotifyRedirectUri: "SPOTIFY_REDIRECT_URI",
};

/** Resolved value for one key: file override first, then env var. */
export function getConfigValue(key: keyof AppSettings): string {
  const file = readSettings();
  const fromFile = file[key];
  if (fromFile && fromFile.trim() !== "") return fromFile.trim();
  return process.env[ENV_KEYS[key]] ?? "";
}

/** All resolved values at once (used by request handlers). */
export function getConfig(): Required<AppSettings> {
  const file = readSettings();
  const out = {} as Required<AppSettings>;
  (Object.keys(ENV_KEYS) as (keyof AppSettings)[]).forEach((k) => {
    const fromFile = file[k];
    out[k] =
      fromFile && fromFile.trim() !== ""
        ? fromFile.trim()
        : process.env[ENV_KEYS[k]] ?? "";
  });
  return out;
}

/** Where a resolved value currently comes from — for display in the UI. */
export type ConfigSource = "file" | "env" | "unset";

export function describeSettings(): Record<
  keyof AppSettings,
  { value: string; isSet: boolean; secret: boolean; source: ConfigSource }
> {
  const file = readSettings();
  const result = {} as Record<
    keyof AppSettings,
    { value: string; isSet: boolean; secret: boolean; source: ConfigSource }
  >;

  (Object.keys(ENV_KEYS) as (keyof AppSettings)[]).forEach((k) => {
    const fromFile = file[k] && file[k]!.trim() !== "" ? file[k]!.trim() : "";
    const fromEnv = process.env[ENV_KEYS[k]] ?? "";
    const resolved = fromFile || fromEnv;
    const source: ConfigSource = fromFile ? "file" : fromEnv ? "env" : "unset";
    const secret = SECRET_FIELDS.includes(k);
    result[k] = {
      // Mask secrets; surface non-secret values so the user can confirm them.
      value: secret ? "" : resolved,
      isSet: resolved !== "",
      secret,
      source,
    };
  });

  return result;
}
