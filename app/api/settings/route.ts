import { NextRequest, NextResponse } from "next/server";
import {
  AppSettings,
  SECRET_FIELDS,
  describeSettings,
  readSettings,
  writeSettings,
} from "@/app/lib/serverConfig";

export const runtime = "nodejs";

const FIELDS: (keyof AppSettings)[] = [
  "acrHost",
  "acrAccessKey",
  "acrAccessSecret",
  "spotifyClientId",
  "spotifyClientSecret",
  "spotifyRedirectUri",
];

/** Returns the current resolved config (secrets masked) + where each value comes from. */
export async function GET() {
  return NextResponse.json({ settings: describeSettings() });
}

/**
 * Persists settings to the on-disk override file.
 * - Non-secret fields: an empty string clears the file override (falls back to env).
 * - Secret fields: an empty/absent value leaves the stored secret unchanged, so the
 *   UI never has to round-trip the secret back to the browser.
 */
export async function POST(req: NextRequest) {
  let body: Partial<AppSettings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const current = readSettings();
  const next: AppSettings = { ...current };

  for (const field of FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    const isSecret = SECRET_FIELDS.includes(field);

    if (typeof value !== "string") continue;
    const trimmed = value.trim();

    if (isSecret) {
      // Only overwrite a secret when a new non-empty value is supplied.
      if (trimmed !== "") next[field] = trimmed;
    } else if (trimmed === "") {
      delete next[field];
    } else {
      next[field] = trimmed;
    }
  }

  try {
    writeSettings(next);
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to save settings: " + (err?.message ?? String(err)) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, settings: describeSettings() });
}
