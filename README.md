# 🎧 Sync2Music

Listen to music playing **right now** in the room, identify it, and play the same
song **from the same position** on Spotify — phase-aligned with the live audio that
kept playing the whole time we were recognizing it.

The hard part isn't recognition, it's **time alignment**: by the time a clip is
recorded, recognized, and streaming starts, the real song has moved on by several
seconds. Sync2Music measures and compensates for every delay — clip length,
recognition round-trip, and the streaming player's start-up latency — then closes the
loop to correct residual drift.

## How it works

```
Mic (AudioWorklet, precise t_clip_start)
   │  ~6s WAV clip
   ▼
/api/identify ──HMAC-SHA1──► ACRCloud /v1/identify ──► play_offset_ms + Spotify track id
   │
   ▼
Sync math:  target_seek = playOffset + (now − t_clip_start) + startLatency + userTrim
   │
   ▼
Spotify Web Playback SDK: seek + play  ──►  drift-correction loop refines startLatency
```

- **`play_offset_ms`** from ACRCloud is the song position at the *start* of the clip —
  our anchor. We timestamp that instant with `AudioContext.getOutputTimestamp()` so the
  anchor maps tightly to `performance.now()`.
- After playback starts we read the SDK's reported position, compare it to where the
  live song should be, fold the error into a **learned start-latency** (persisted to
  `localStorage`), and issue one corrective seek. A manual **offset trim** slider and
  ±100 ms nudge buttons handle speaker/room output latency.

See `app/lib/syncMath.ts` for the (unit-tested) core math.

## Prerequisites

- **Node 18+**
- **Spotify Premium** account (the Web Playback SDK + `seek` require it)
- A **Spotify app** — https://developer.spotify.com/dashboard
  - Add redirect URI: `http://localhost:3000/api/spotify/callback`
- An **ACRCloud** "Audio & Video Recognition" project — https://console.acrcloud.com
  - Note your project's **host**, **access key**, and **access secret**
  - Enable the **Spotify** third-party id in the project's metadata settings so matches
    include a Spotify track id.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000 (mic access works on `localhost` without HTTPS).

### Configuration — two options

- **In-app Settings page (`/settings`)** — enter your ACRCloud + Spotify credentials
  and tune the sync behavior right in the browser. Credentials are saved server-side to
  `.data/settings.json` (git-ignored) and take precedence over env vars; secrets are
  write-only and never sent back to the browser. Sync tuning is stored per-browser.
- **Environment variables** — alternatively `cp .env.example .env.local` and fill it in.
  These act as defaults when nothing is set on the Settings page.

1. Click **Connect Spotify** and authorize (Premium account).
2. Play a well-known song from another speaker/device.
3. Click **🎙️ Listen & Sync**. Status advances Listening → Identifying → Syncing →
   Playing, and Spotify resumes mid-song near the live position.
4. Fine-tune with the **offset trim** slider / **± nudge** buttons if needed — the
   learned latency makes the next run tighter.

## Environment variables

| Variable | Description |
| --- | --- |
| `ACR_HOST` | ACRCloud project host, e.g. `identify-eu-west-1.acrcloud.com` |
| `ACR_ACCESS_KEY` / `ACR_ACCESS_SECRET` | ACRCloud project credentials (server-only) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify app credentials (server-only) |
| `SPOTIFY_REDIRECT_URI` | Must match the dashboard, default `http://localhost:3000/api/spotify/callback` |
| `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | Public client id (same value as `SPOTIFY_CLIENT_ID`) |

Secrets stay on the server: the browser only ever receives short-lived Spotify access
tokens; the ACRCloud secret is used only to sign requests in `/api/identify`.

## Tests

```bash
npm test
```

Covers the pure sync math (`syncMath.test.ts`) and the ACRCloud signature builder
(`acrSign.test.ts`).

## Limitations

- Precision is bounded by network jitter and Spotify's streaming buffer; the
  drift-correction loop + manual trim get alignment into a small, perceptually-tight
  window rather than sample-exact.
- A match needs a Spotify track id from ACRCloud; obscure/unavailable tracks can't be played.
- Browser autoplay rules require the sync to be triggered from a user click (it is).
