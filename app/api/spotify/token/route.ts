import { NextRequest, NextResponse } from "next/server";
import { refreshAccessToken, REFRESH_COOKIE } from "@/app/lib/spotifyAuth";

export const runtime = "nodejs";

/**
 * Returns a fresh access token for the Web Playback SDK, derived from the
 * httpOnly refresh-token cookie. Returns 401 if the user hasn't connected.
 */
export async function GET(req: NextRequest) {
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json({ connected: false }, { status: 401 });
  }

  try {
    const tokens = await refreshAccessToken(refreshToken);
    const res = NextResponse.json({
      connected: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
    });
    // Spotify may rotate the refresh token; persist the new one if present.
    if (tokens.refresh_token) {
      res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return res;
  } catch {
    const res = NextResponse.json({ connected: false }, { status: 401 });
    res.cookies.delete(REFRESH_COOKIE);
    return res;
  }
}
