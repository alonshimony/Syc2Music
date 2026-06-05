// Server-side Spotify OAuth helpers (Authorization Code flow). The refresh token
// is stored in an httpOnly cookie; the short-lived access token is handed to the
// browser on demand for the Web Playback SDK.

import { getConfig } from "./serverConfig";

export const REFRESH_COOKIE = "s2m_refresh";

export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

function basicAuthHeader(): string {
  const { spotifyClientId, spotifyClientSecret } = getConfig();
  return (
    "Basic " +
    Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString("base64")
  );
}

export async function exchangeCodeForTokens(
  code: string
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getConfig().spotifyRedirectUri,
  });
  return tokenRequest(body);
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenRequest(body);
}

async function tokenRequest(
  body: URLSearchParams
): Promise<SpotifyTokenResponse> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as SpotifyTokenResponse;
}
