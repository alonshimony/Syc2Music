import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, REFRESH_COOKIE } from "@/app/lib/spotifyAuth";
import {
  SETTINGS_COOKIE,
  parseSettingsCookie,
  resolveConfig,
  resolveRedirectUri,
} from "@/app/lib/serverConfig";

export const runtime = "nodejs";

/** Spotify redirects here with ?code=...; we exchange it and store the refresh token. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const expectedState = req.cookies.get("s2m_oauth_state")?.value;

  const home = new URL("/", url.origin);

  if (error) {
    home.searchParams.set("spotify_error", error);
    return NextResponse.redirect(home);
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    home.searchParams.set("spotify_error", "state_mismatch");
    return NextResponse.redirect(home);
  }

  const cfg = resolveConfig(
    parseSettingsCookie(req.cookies.get(SETTINGS_COOKIE)?.value)
  );
  // Use the same redirect URI the login step used (derived from origin if unset),
  // since Spotify requires the token exchange to echo the exact value.
  cfg.spotifyRedirectUri = resolveRedirectUri(cfg, req.nextUrl.origin);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, cfg);
  } catch {
    home.searchParams.set("spotify_error", "token_exchange_failed");
    return NextResponse.redirect(home);
  }

  home.searchParams.set("spotify", "connected");
  const res = NextResponse.redirect(home);

  if (tokens.refresh_token) {
    res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // 30 days; refresh tokens are long-lived but we cap the cookie.
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  res.cookies.delete("s2m_oauth_state");
  return res;
}
