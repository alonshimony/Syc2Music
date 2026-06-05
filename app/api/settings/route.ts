import { NextRequest, NextResponse } from "next/server";
import {
  AppSettings,
  SECRET_FIELDS,
  SETTINGS_COOKIE,
  SETTINGS_FIELDS,
  describeSettings,
  parseSettingsCookie,
  serializeSettingsCookie,
  settingsCookieOptions,
} from "@/app/lib/serverConfig";

export const runtime = "nodejs";

/** Returns the current resolved config (secrets masked) + where each value comes from. */
export async function GET(req: NextRequest) {
  const settings = parseSettingsCookie(req.cookies.get(SETTINGS_COOKIE)?.value);
  return NextResponse.json({ settings: describeSettings(settings) });
}

/**
 * Persists settings to an httpOnly cookie.
 * - Non-secret fields: an empty string clears the override (falls back to env).
 * - Secret fields: an empty/absent value leaves the stored secret unchanged, so the
 *   UI never has to round-trip the secret back to the browser.
 */
export async function POST(req: NextRequest) {
  let body: Partial<AppSettings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const current = parseSettingsCookie(req.cookies.get(SETTINGS_COOKIE)?.value);
  const next: AppSettings = { ...current };

  for (const field of SETTINGS_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    const isSecret = SECRET_FIELDS.includes(field);

    if (isSecret) {
      // Only overwrite a secret when a new non-empty value is supplied.
      if (trimmed !== "") next[field] = trimmed;
    } else if (trimmed === "") {
      delete next[field];
    } else {
      next[field] = trimmed;
    }
  }

  const res = NextResponse.json({
    ok: true,
    settings: describeSettings(next),
  });
  res.cookies.set(
    SETTINGS_COOKIE,
    serializeSettingsCookie(next),
    settingsCookieOptions()
  );
  return res;
}
