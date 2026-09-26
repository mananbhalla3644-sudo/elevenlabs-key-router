# Eleven KeyFlow

A small, dependency-free Node.js dashboard that keeps up to **10 ElevenLabs API keys** on the server and fails over to the next available key when the current key is rate-limited, invalid, or unauthorized. It also provides a text-to-speech studio and an upload-based voice changer.

> Use only API keys and accounts you own or are authorized to use. Multiple-key failover must not be used to evade subscription, character, concurrency, or other plan limits. Follow the [ElevenLabs Terms](https://elevenlabs.io/terms) and current API limits.

## What it does

- Adds up to 10 ElevenLabs API keys through the dashboard or `ELEVENLABS_KEYS`.
- Keeps dashboard-added keys in server memory only; raw keys are not returned, logged, or written to disk.
- Rotates automatically on ElevenLabs `429`, `401`, `402`, and `403` responses.
- Respects valid `Retry-After` values and applies bounded cooldowns.
- Shows masked key status, cooldowns, counters, capacity, and a live activity log.
- Generates speech with playback and download.
- Converts an uploaded audio file to a selected ElevenLabs voice, then plays or downloads the result.
- Supports an optional single dashboard token for controlled deployments.
- Has no runtime npm dependencies; it uses Node.js 18+ native HTTP and `fetch`.

The voice changer is an **upload → convert → play/download** workflow. It does not record a live microphone, stream a conversation, or provide continuation support.

## Requirements

- Node.js 18 or newer.
- One or more authorized ElevenLabs API keys.
- A modern browser with `fetch`, `ReadableStream`, and `sessionStorage` support.

No `npm install` is needed.

## Start it

On Windows, double-click **`start.bat`**, or run:

```powershell
cd path\to\elevenlabs-key-router
npm start
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).

On macOS/Linux:

```bash
cd "/path/to/elevenlabs-key-router"
npm start
```

The default listener is loopback-only (`127.0.0.1`).

## Add keys from the dashboard

1. Open the dashboard over a trusted loopback connection or HTTPS.
2. Paste one key per line in the bulk field (up to ten keys).
3. Click **Add to pool**.
4. The browser sends the keys to the Node process over the current connection. The input is cleared after a successful request.
5. The key list, status cards, and activity log show only masked metadata.

Keys added through the dashboard disappear when the Node process stops. To preload keys, use a trusted process environment or secret manager:

### PowerShell

```powershell
$env:ELEVENLABS_KEYS="your_key_1,your_key_2,your_key_3"
npm start
```

### macOS/Linux

```bash
ELEVENLABS_KEYS="your_key_1,your_key_2,your_key_3" npm start
```

Values are comma-separated, trimmed, de-duplicated, and limited to 10.

## Text-to-speech studio

Enter text, choose a voice/model and output format, and select **Generate speech**. The server validates the request, streams the returned audio to the browser, and exposes playback and a download action. A successful upstream request is never replayed automatically.

## Upload-based voice changer

1. Choose or drop an audio file.
2. Select a target ElevenLabs voice, model, and output format.
3. Optionally request background-noise removal.
4. Select **Convert voice**.
5. Play the converted result or download it with a format-appropriate filename.

The server accepts raw uploads up to **50 MiB** (`50 * 1024 * 1024` bytes). The browser checks common extensions and file size before uploading. The server checks the upload content type and rejects empty or oversized bodies before contacting ElevenLabs. Common source formats include MP3, WAV, M4A/MP4, AAC, FLAC, OGG/Opus, and WebM; availability depends on the selected ElevenLabs model and account.

The browser route is:

```text
POST /api/voice-changer
```

`/api/speech-to-speech` is retained as an alias. Voice metadata is sent as query parameters and the audio is sent as the raw request body; the server constructs the upstream multipart request without persisting the upload.

## Optional dashboard authentication

For a shared or deployed instance, set a long random token before starting:

```powershell
$env:DASHBOARD_TOKEN="replace-with-a-long-random-token"
npm start
```

The dashboard asks for this token and keeps it only in `sessionStorage` for the current tab/session. It is sent as a Bearer token to this app's API. The token is not placed in the key list or application logs.

The server requires `DASHBOARD_TOKEN` whenever `HOST` is not a loopback address:

```powershell
$env:HOST="0.0.0.0"
$env:PORT="3000"
$env:DASHBOARD_TOKEN="replace-with-a-long-random-token"
npm start
```

For any non-local deployment:

- Terminate TLS with HTTPS at the app or a trusted reverse proxy.
- Preserve the `Host`/`Origin` boundary expected by the dashboard.
- Restrict access to the dashboard and API with a firewall, VPN, or authenticated proxy.
- Do not expose the key-management API to untrusted users.
- Prefer `ELEVENLABS_KEYS` injected by a secret manager over sending keys through a browser.

The browser deliberately blocks key and token entry on a non-loopback plain-HTTP origin. This prevents credentials from being submitted over an unprotected transport. The dashboard token is a single shared administrator credential, not a multi-user identity system.

## Rotation and retry safety

For each user request, the router tries each ready key at most once in round-robin order:

- `429`: put the key in cooldown and try the next ready key.
- `401`: disable the key as invalid and try the next ready key.
- `402`: disable the key as depleted and try the next ready key.
- `403`: disable the key as unauthorized and try the next ready key.
- `Retry-After`: accept delta-seconds or a standard HTTP date, bounded to 24 hours; use a short default when absent or malformed.
- A successful upstream response, an ambiguous network timeout, or a `5xx` response is not replayed.
- An empty or non-audio success response is rejected and is not replayed.

A `429` may reflect a per-key limit or a globally busy service. The router does not loop indefinitely or use failover to evade plan limits.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address; non-loopback requires a dashboard token. |
| `PORT` | `3000` | Listen port. |
| `ELEVENLABS_KEYS` | empty | Comma-separated preload keys, maximum 10. |
| `DASHBOARD_TOKEN` | empty | Optional Bearer token for dashboard API routes. |
| `ELEVENLABS_API_BASE` | `https://api.elevenlabs.io` | Upstream HTTP(S) origin, optionally with a path prefix. |
| `ELEVENLABS_API_BASE_URL` | — | Alias for `ELEVENLABS_API_BASE`. |
| `ELEVENLABS_REQUEST_TIMEOUT_MS` | `120000` | Overall upstream request timeout; also bounds how long a client may take to send its body (`408`). |

`ELEVENLABS_API_BASE` is validated at startup and must be an HTTP(S) URL without credentials, query parameters, or fragments. A configured path prefix is preserved, which is useful for controlled mock or compatible upstreams.

## Test and review status

```powershell
npm test
```

The test suite uses Node's built-in test runner and does not call ElevenLabs. It covers key masking and limits, failover, retry handling, upload validation and multipart forwarding, response validation, stalled-body timeouts, API-base path handling, and the speech-to-speech alias.

This project is not a substitute for a production security review. Before exposing it beyond a trusted local machine, complete deployment-specific browser, cancellation, load, secret-leakage, and HTTPS/reverse-proxy checks.

## Files

- `server.js` — routes, authentication, upload validation, proxying, failover, and audio response handling.
- `lib/http.js` — body readers, static serving, security headers, and safe response helpers.
- `lib/key-pool.js` — in-memory key records, masking, cooldowns, disablement, and round-robin selection.
- `public/` — dashboard HTML, CSS, and browser JavaScript.
- `test/` — key-pool, utility, and HTTP integration tests.
