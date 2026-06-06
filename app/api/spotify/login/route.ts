import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { SPOTIFY_SCOPES } from "@/app/lib/spotifyAuth";
import {
  SETTINGS_COOKIE,
  parseSettingsCookie,
  resolveConfig,
  resolveRedirectUri,
} from "@/app/lib/serverConfig";

export const runtime = "nodejs";

/** Redirects the browser to Spotify's authorization page. */
export async function GET(req: NextRequest) {
  const cfg = resolveConfig(
    parseSettingsCookie(req.cookies.get(SETTINGS_COOKIE)?.value)
  );
  const clientId = cfg.spotifyClientId;
  const redirectUri = resolveRedirectUri(cfg, req.nextUrl.origin);

  const missing: string[] = [];
  if (!cfg.spotifyClientId) missing.push("Spotify client ID");
  if (!cfg.spotifyClientSecret) missing.push("Spotify client secret");
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing ${missing.join(" and ")}. Open the Settings page (⚙️), enter these, and click "Save credentials" in the same browser you're using here.`,
      },
      { status: 500 }
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SPOTIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  const res = NextResponse.redirect(
    `https://accounts.spotify.com/authorize?${params.toString()}`
  );
  // CSRF guard, validated in the callback.
  res.cookies.set("s2m_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
