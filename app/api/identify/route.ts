import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { buildAcrSignature } from "@/app/lib/acrSign";
import {
  SETTINGS_COOKIE,
  parseSettingsCookie,
  resolveConfig,
} from "@/app/lib/serverConfig";
import type { IdentifyResponse } from "@/app/lib/types";

export const runtime = "nodejs";

/**
 * Receives a WAV clip from the browser, signs and forwards it to ACRCloud's
 * /v1/identify endpoint, and returns the normalized match (Spotify track id +
 * play_offset_ms, our sync anchor). Secrets never leave the server.
 */
export async function POST(req: NextRequest): Promise<NextResponse<IdentifyResponse>> {
  const {
    acrHost: host,
    acrAccessKey: accessKey,
    acrAccessSecret: accessSecret,
  } = resolveConfig(parseSettingsCookie(req.cookies.get(SETTINGS_COOKIE)?.value));

  if (!host || !accessKey || !accessSecret) {
    return NextResponse.json(
      {
        status: "error",
        message:
          "ACRCloud is not configured. Add credentials on the Settings page.",
      },
      { status: 500 }
    );
  }

  let audio: ArrayBuffer;
  try {
    audio = await req.arrayBuffer();
  } catch {
    return NextResponse.json(
      { status: "error", message: "Could not read uploaded audio." },
      { status: 400 }
    );
  }

  const sample = Buffer.from(audio);
  if (sample.length === 0) {
    return NextResponse.json(
      { status: "error", message: "Empty audio clip." },
      { status: 400 }
    );
  }
  if (sample.length > 5 * 1024 * 1024) {
    return NextResponse.json(
      { status: "error", message: "Audio clip exceeds ACRCloud's 5MB limit." },
      { status: 400 }
    );
  }

  const httpMethod = "POST";
  const httpUri = "/v1/identify";
  const dataType = "audio";
  const signatureVersion = "1";
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const signature = buildAcrSignature(
    { httpMethod, httpUri, accessKey, dataType, signatureVersion, timestamp },
    accessSecret,
    crypto
  );

  const form = new FormData();
  form.append("access_key", accessKey);
  form.append("sample_bytes", sample.length.toString());
  form.append("timestamp", timestamp);
  form.append("signature", signature);
  form.append("data_type", dataType);
  form.append("signature_version", signatureVersion);
  // Field name must be "sample"; ACRCloud accepts arbitrary filename/mime.
  form.append("sample", new Blob([sample], { type: "audio/wav" }), "clip.wav");

  let acrJson: any;
  try {
    const acrRes = await fetch(`https://${host}${httpUri}`, {
      method: httpMethod,
      body: form,
    });
    acrJson = await acrRes.json();
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: "Failed to reach ACRCloud." },
      { status: 502 }
    );
  }

  const code = acrJson?.status?.code;
  // ACRCloud: 0 = success, 1001 = no result.
  if (code === 1001) {
    return NextResponse.json({ status: "no_match" });
  }
  if (code !== 0) {
    return NextResponse.json(
      {
        status: "error",
        message: acrJson?.status?.msg || "ACRCloud returned an error.",
      },
      { status: 502 }
    );
  }

  const music = acrJson?.metadata?.music?.[0];
  if (!music) {
    return NextResponse.json({ status: "no_match" });
  }

  const spotifyTrackId: string | null =
    music?.external_metadata?.spotify?.track?.id ?? null;

  const artist = Array.isArray(music.artists)
    ? music.artists.map((a: any) => a?.name).filter(Boolean).join(", ")
    : "";

  return NextResponse.json({
    status: "ok",
    result: {
      spotifyTrackId,
      title: music.title ?? "Unknown title",
      artist: artist || "Unknown artist",
      album: music?.album?.name ?? null,
      playOffsetMs:
        typeof music.play_offset_ms === "number" ? music.play_offset_ms : 0,
      durationMs:
        typeof music.duration_ms === "number" ? music.duration_ms : null,
    },
  });
}
