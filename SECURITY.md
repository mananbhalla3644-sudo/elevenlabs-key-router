# Security notes

Eleven KeyFlow is designed for a trusted local process first. It is not a multi-tenant authorization service and has not been certified as production-complete. Review the deployment and run the test/browser checks appropriate to your environment before exposing it.

## Key and token handling

- ElevenLabs API keys are accepted by the dashboard/API and held by the Node.js process in memory only.
- Raw keys are never returned by `GET /api/keys`, written to disk, placed in browser storage, or intentionally logged.
- Key-list responses contain masked metadata and counters, not the secret values used for upstream requests.
- The browser clears the key-entry field after a successful add request. It does not put submitted keys in `localStorage`, `sessionStorage`, URLs, or the activity log.
- `DASHBOARD_TOKEN`, when configured, is stored by the frontend only in `sessionStorage` for the current tab/session and is sent as a Bearer token to this app.
- `ELEVENLABS_KEYS` is intended for a trusted process environment or secret manager. Do not commit populated `.env` files, paste real keys into source code, or include them in logs, screenshots, or bug reports.
- Audio is processed in memory for the request and is not persisted by this application. Browser playback uses an object URL that is revoked when replaced or cleared.

## Transport and deployment

The default listener is `127.0.0.1`, which limits access to the local machine. `startServer` refuses to start with a non-loopback `HOST` unless `DASHBOARD_TOKEN` is configured.

Before binding the app to a public or LAN interface:

1. Set a long, random `DASHBOARD_TOKEN`.
2. Put the app behind HTTPS and an authenticated reverse proxy, VPN, or firewall.
3. Preserve the expected `Host`/`Origin` boundary and do not forward untrusted request headers.
4. Restrict access to the key-management, TTS, and voice-changer routes.
5. Prefer `ELEVENLABS_KEYS` injected by a secret manager over sending keys through a browser.
6. Do not expose the key list, activity log, browser developer tools, or process environment to untrusted users.

The browser blocks key and token entry on a non-loopback plain-HTTP origin. This is a fail-closed guard, not a replacement for HTTPS. The optional dashboard token is a single shared administrator credential, not a full identity or multi-user authorization system.

## Cross-site and request-boundary protections

- JSON mutation routes require an `application/json` content type; simple cross-site `text/plain` requests are rejected.
- API requests with a cross-site `Origin` or `Sec-Fetch-Site: cross-site` are rejected.
- Authorization uses a constant-time comparison of SHA-256 digests for the configured dashboard token.
- API error codes/messages and public headers are allowlisted; upstream MIME parameters and arbitrary error headers are not reflected.
- Static assets use restrictive CSP and related browser security headers.

These checks reduce common browser CSRF and response-boundary mistakes, but a reverse proxy must still enforce authentication, TLS, host validation, and network access controls.

## Voice-changer upload boundary

- `POST /api/voice-changer` and its `/api/speech-to-speech` alias accept a raw audio upload, not multipart browser form data.
- The maximum upload is 50 MiB (`50 * 1024 * 1024` bytes); query and content-type validation happens before buffering where possible.
- Empty and oversized uploads are rejected before an ElevenLabs request is made.
- A client that stops sending its body is cut off with `408 REQUEST_TIMEOUT` after `ELEVENLABS_REQUEST_TIMEOUT_MS`, so a stalled upload cannot hold a connection open indefinitely.
- The server constructs a bounded multipart request in memory and does not write the source or converted audio to disk.
- The upload is an explicit file conversion only. There is no microphone permission, live streaming, or continuation endpoint.
- Treat source and converted audio as sensitive content. Do not upload recordings without the necessary rights or consent.

## Retry and upstream safety

The router moves to another key only for responses that indicate a key/account is unavailable (`429`, `401`, `402`, or `403`). It does not automatically replay a request after a successful upstream response, an ambiguous network timeout, a stalled/invalid audio response, or a `5xx` response. This avoids accidentally generating and billing the same audio twice after an uncertain failure.

The app tries each currently ready key at most once for one user request and does not implement an unbounded retry loop. Valid `Retry-After` delta-seconds and HTTP-date values are honored with a bounded cooldown; malformed or extreme values do not create unbounded dates.

Client disconnects and the overall upstream timeout are propagated to the upstream request. A response that began streaming but fails is not replayed, because the upstream may already have generated or billed it.

## Operational limits

- Maximum key count: 10.
- JSON body limit: 256 KiB.
- Voice-changer upload limit: 50 MiB.
- TTS text limit: 100,000 JavaScript characters.
- Default upstream timeout: 120,000 ms; the same value also bounds how long a client may take to finish sending its request body. Tune only with awareness of billing and client behavior.

These are application safeguards, not a substitute for rate limiting, upload concurrency controls, monitoring, or a production reverse proxy.

## Reporting a vulnerability

Do not include real API keys, dashboard tokens, generated private audio, source recordings, or other secrets in a report. Rotate any credential that may have been exposed and share only a minimal reproduction with versions, endpoint, and sanitized logs.
