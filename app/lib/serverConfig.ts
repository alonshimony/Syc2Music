// Server-side configuration store. Values can come from two places:
//   1. Environment variables — the original mechanism / deploy-time defaults.
//   2. An httpOnly cookie written by the in-app Settings page (takes precedence).
//
// A cookie is used (rather than a file) so this works on read-only serverless
// filesystems (e.g. Vercel's /var/task) as well as locally, with no database. The
// cookie is httpOnly + secure, so credentials are never readable from client JS and
// only travel over HTTPS in production. Settings are therefore per-browser.

export interface AppSettings {
  acrHost?: string;
  acrAccessKey?: string;
  acrAccessSecret?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRedirectUri?: string;
}

export type ResolvedConfig = Required<AppSettings>;

/** Fields the UI treats as secret — never returned to the browser in clear text. */
export const SECRET_FIELDS: ReadonlyArray<keyof AppSettings> = [
  "acrAccessSecret",
  "spotifyClientSecret",
];

export const SETTINGS_COOKIE = "s2m_settings";

const ENV_KEYS: Record<keyof AppSettings, string> = {
  acrHost: "ACR_HOST",
  acrAccessKey: "ACR_ACCESS_KEY",
  acrAccessSecret: "ACR_ACCESS_SECRET",
  spotifyClientId: "SPOTIFY_CLIENT_ID",
  spotifyClientSecret: "SPOTIFY_CLIENT_SECRET",
  spotifyRedirectUri: "SPOTIFY_REDIRECT_URI",
};

export const SETTINGS_FIELDS = Object.keys(ENV_KEYS) as (keyof AppSettings)[];

/** Parse the settings cookie value into an AppSettings object. */
export function parseSettingsCookie(value: string | undefined): AppSettings {
  if (!value) return {};
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as AppSettings) : {};
  } catch {
    return {};
  }
}

/** Serialize settings for storage in a cookie. */
export function serializeSettingsCookie(settings: AppSettings): string {
  return Buffer.from(JSON.stringify(settings), "utf8").toString("base64");
}

/** Merge cookie settings over env vars into a fully-resolved config. */
export function resolveConfig(settings: AppSettings): ResolvedConfig {
  const out = {} as ResolvedConfig;
  for (const key of SETTINGS_FIELDS) {
    const fromCookie = settings[key];
    out[key] =
      fromCookie && fromCookie.trim() !== ""
        ? fromCookie.trim()
        : process.env[ENV_KEYS[key]] ?? "";
  }
  return out;
}

/** Where a resolved value currently comes from — for display in the UI. */
export type ConfigSource = "cookie" | "env" | "unset";

export interface FieldDescription {
  value: string;
  isSet: boolean;
  secret: boolean;
  source: ConfigSource;
}

export function describeSettings(
  settings: AppSettings
): Record<keyof AppSettings, FieldDescription> {
  const result = {} as Record<keyof AppSettings, FieldDescription>;

  for (const key of SETTINGS_FIELDS) {
    const fromCookie =
      settings[key] && settings[key]!.trim() !== "" ? settings[key]!.trim() : "";
    const fromEnv = process.env[ENV_KEYS[key]] ?? "";
    const resolved = fromCookie || fromEnv;
    const source: ConfigSource = fromCookie ? "cookie" : fromEnv ? "env" : "unset";
    const secret = SECRET_FIELDS.includes(key);
    result[key] = {
      // Mask secrets; surface non-secret values so the user can confirm them.
      value: secret ? "" : resolved,
      isSet: resolved !== "",
      secret,
      source,
    };
  }

  return result;
}

/** Cookie options shared by every place that writes the settings cookie. */
export function settingsCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  };
}

/**
 * The Spotify redirect URI to use. If the user didn't set one explicitly, derive
 * it from the request origin (e.g. https://your-app.vercel.app/api/spotify/callback)
 * so it works out of the box and stays consistent between login and callback.
 */
export function resolveRedirectUri(cfg: ResolvedConfig, origin: string): string {
  return cfg.spotifyRedirectUri || `${origin}/api/spotify/callback`;
}
