import { NextResponse } from "next/server";
import crypto from "crypto";
import { SPOTIFY_SCOPES } from "@/app/lib/spotifyAuth";
import { getConfig } from "@/app/lib/serverConfig";

export const runtime = "nodejs";

/** Redirects the browser to Spotify's authorization page. */
export async function GET() {
  const { spotifyClientId: clientId, spotifyRedirectUri: redirectUri } =
    getConfig();

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "Spotify is not configured. Add credentials on the Settings page." },
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
