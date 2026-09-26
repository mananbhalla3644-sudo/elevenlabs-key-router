'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const { KeyPool, MAX_KEYS } = require('./lib/key-pool');
const {
  HttpError,
  applySecurityHeaders,
  methodNotAllowed,
  readBinary,
  readJson,
  sendError,
  sendJson,
  serveStatic,
  streamWebBody,
} = require('./lib/http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_API_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const JSON_BODY_LIMIT = 256 * 1024;
const MAX_TTS_CHARACTERS = 100_000;
const MAX_VOICE_CHANGER_BYTES = 50 * 1024 * 1024;
const DEFAULT_VOICE_CHANGER_MODEL_ID = 'eleven_multilingual_sts_v2';
const ALLOWED_OUTPUT_FORMATS = new Set([
  'alaw_8000',
  'mp3_22050_32',
  'mp3_24000_48',
  'mp3_44100_128',
  'mp3_44100_192',
  'mp3_44100_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'opus_48000_128',
  'opus_48000_192',
  'opus_48000_32',
  'opus_48000_64',
  'opus_48000_96',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_32000',
  'pcm_44100',
  'pcm_48000',
  'pcm_8000',
  'ulaw_8000',
  'wav_16000',
  'wav_22050',
  'wav_24000',
  'wav_32000',
  'wav_44100',
  'wav_48000',
  'wav_8000',
]);

function createRequestHandler(options = {}) {
  const keyPool = options.keyPool ?? new KeyPool({ maxKeys: MAX_KEYS });
  const publicDir = path.resolve(options.publicDir ?? path.join(__dirname, 'public'));
  const dashboardToken = normalizeDashboardToken(options.dashboardToken);
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const upstreamTimeoutMs = positiveInteger(
    options.upstreamTimeoutMs,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
  );

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  return async function requestHandler(req, res) {
    applySecurityHeaders(res);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'INVALID_URL', 'Invalid request URL');
    }

    if (url.pathname.startsWith('/api/') && isCrossSiteRequest(req)) {
      req.resume();
      throw new HttpError(403, 'CROSS_SITE_REQUEST_BLOCKED', 'Cross-site dashboard requests are not allowed');
    }

    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, ['GET'], req);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        authRequired: Boolean(dashboardToken),
        maxKeys: keyPool.maxKeys,
      });
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, ['GET', 'HEAD'], req);
        return;
      }
      await serveStatic(req, res, publicDir, url.pathname);
      return;
    }

    if (!isAuthorized(req, dashboardToken)) {
      req.resume();
      throw new HttpError(
        401,
        'UNAUTHORIZED',
        'Dashboard authentication required',
        { 'WWW-Authenticate': 'Bearer realm="ElevenLabs Key Router"' },
      );
    }

    if (url.pathname === '/api/keys') {
      if (req.method === 'GET') {
        sendJson(res, 200, keyPool.snapshot());
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, { maxBytes: JSON_BODY_LIMIT, timeoutMs: upstreamTimeoutMs });
        const keyInput = isPlainObject(body) ? body.keys : body;
        if (!isPlainObject(body) && typeof body !== 'string') {
          throw new HttpError(400, 'INVALID_BODY', 'Request body must contain keys');
        }
        const result = keyPool.addKeys(keyInput);
        const snapshot = keyPool.snapshot();
        sendJson(res, 200, {
          ok: true,
          added: result.added,
          keys: result.keys,
          stats: snapshot.stats,
          maxKeys: snapshot.maxKeys,
        });
        return;
      }
      if (req.method === 'DELETE') {
        keyPool.clear();
        sendJson(res, 200, {
          ok: true,
          ...keyPool.snapshot(),
        });
        return;
      }
      methodNotAllowed(res, ['GET', 'POST', 'DELETE'], req);
      return;
    }

    if (url.pathname === '/api/keys/reset') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST'], req);
        return;
      }
      const snapshot = keyPool.reset();
      sendJson(res, 200, {
        ok: true,
        ...snapshot,
      });
      return;
    }

    if (url.pathname === '/api/voice-changer' || url.pathname === '/api/speech-to-speech') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST'], req);
        return;
      }
      const contentType = normalizeUploadContentType(req.headers['content-type']);
      if (!contentType) {
        req.resume();
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload must be an audio file');
      }
      let request;
      try {
        request = validateVoiceChangerRequest(url.searchParams, contentType);
      } catch (error) {
        req.resume();
        throw error;
      }
      const audio = await readBinary(req, { maxBytes: MAX_VOICE_CHANGER_BYTES, timeoutMs: upstreamTimeoutMs });
      if (audio.length === 0) {
        throw new HttpError(400, 'EMPTY_AUDIO_FILE', 'Uploaded audio file is empty');
      }
      request.audio = audio;
      await proxyVoiceChanger({
        req,
        res,
        keyPool,
        request,
        apiBaseUrl,
        fetchImpl,
        upstreamTimeoutMs,
      });
      return;
    }

    if (url.pathname === '/api/tts') {
      if (req.method !== 'POST') {
        methodNotAllowed(res, ['POST'], req);
        return;
      }
      const body = await readJson(req, { maxBytes: JSON_BODY_LIMIT, timeoutMs: upstreamTimeoutMs });
      const request = validateTtsRequest(body);
      await proxyTts({
        req,
        res,
        keyPool,
        request,
        apiBaseUrl,
        fetchImpl,
        upstreamTimeoutMs,
      });
      return;
    }

    req.resume();
    throw new HttpError(404, 'NOT_FOUND', 'API endpoint not found');
  };
}

function createServer(options = {}) {
  const keyPool = options.keyPool ?? new KeyPool({ maxKeys: MAX_KEYS });
  if (options.keys !== undefined) {
    keyPool.addKeys(options.keys);
  }

  const requestHandler = createRequestHandler({ ...options, keyPool });
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      try {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendError(res, error);
      } catch {
        if (!res.destroyed) {
          res.destroy();
        }
      }
    });
  });

  server.keyPool = keyPool;
  server.requestHandler = requestHandler;
  server.on('clientError', (error, socket) => {
    if (error.code === 'HPE_HEADER_OVERFLOW') {
      socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!socket.destroyed && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  return server;
}

function startServer(env = process.env) {
  const keys = parseEnvironmentKeys(env.ELEVENLABS_KEYS);
  const port = parsePort(env.PORT, DEFAULT_PORT);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const dashboardToken = normalizeDashboardToken(env.DASHBOARD_TOKEN);
  if (!isLoopbackHost(host) && !dashboardToken) {
    throw new Error('DASHBOARD_TOKEN is required when HOST is not loopback');
  }
  const keyPool = new KeyPool({ maxKeys: MAX_KEYS });
  keyPool.addKeys(keys);

  const server = createServer({
    keyPool,
    dashboardToken,
    publicDir: path.join(__dirname, 'public'),
    apiBaseUrl:
      env.ELEVENLABS_API_BASE ??
      env.ELEVENLABS_API_BASE_URL ??
      DEFAULT_API_BASE_URL,
    upstreamTimeoutMs: parsePositiveInteger(
      env.ELEVENLABS_REQUEST_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    ),
  });

  server.once('error', () => {
    process.stderr.write('Unable to listen for ElevenLabs key router\n');
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = typeof address === 'object' && address ? address.port : port;
    process.stdout.write(`ElevenLabs key router listening on http://${host}:${listeningPort}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`Received ${signal}; shutting down\n`);

    const forceExit = setTimeout(() => {
      server.closeAllConnections?.();
      process.exitCode = 1;
    }, 10_000);
    forceExit.unref();

    server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

async function proxyTts(context) {
  const { req, res, keyPool, request, apiBaseUrl, fetchImpl, upstreamTimeoutMs } = context;
  const attempted = new Set();
  let sawRateLimit = false;
  let earliestRetryAt = Number.POSITIVE_INFINITY;

  while (true) {
    const id = keyPool.acquire(attempted);
    if (!id) {
      break;
    }

    attempted.add(id);
    keyPool.markRequest(id);
    const key = keyPool.keyFor(id);
    if (!key) {
      continue;
    }

    const endpoint = buildUpstreamEndpoint(
      apiBaseUrl,
      `v1/text-to-speech/${encodeURIComponent(request.voiceId)}`,
    );
    endpoint.searchParams.set('output_format', request.outputFormat);

    const lifecycle = createUpstreamLifecycle(req, res, upstreamTimeoutMs);
    try {
      let upstream;
      try {
        upstream = await fetchImpl(endpoint.toString(), {
          method: 'POST',
          headers: {
            Accept: 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': key,
          },
          body: JSON.stringify({
            text: request.text,
            model_id: request.modelId,
          }),
          signal: lifecycle.signal,
          redirect: 'error',
        });
      } catch {
        keyPool.markFailure(id, 'network_error');
        throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'ElevenLabs could not be reached');
      }

      const upstreamOk = upstream.ok ?? (
        Number.isInteger(upstream.status) && upstream.status >= 200 && upstream.status < 300
      );
      if (upstreamOk) {
        if (hasDeclaredEmptyBody(upstream)) {
          keyPool.markFailure(id, 'empty_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an empty audio response');
        }
        const upstreamContentType = responseHeader(upstream, 'content-type');
        if (!isAudioResponseType(upstreamContentType)) {
          await discardUpstreamBody(upstream.body);
          keyPool.markFailure(id, 'invalid_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned a non-audio response');
        }

        let audioBody;
        try {
          audioBody = await prepareAudioBody(upstream.body);
        } catch {
          keyPool.markFailure(id, 'audio_stream_error');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an unreadable audio response');
        }
        if (!audioBody) {
          keyPool.markFailure(id, 'empty_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an empty audio response');
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', safeAudioContentType(upstreamContentType, contentTypeForOutput(request.outputFormat)));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'inline');
        try {
          await streamWebBody(audioBody, res);
          keyPool.markSuccess(id);
        } catch (error) {
          keyPool.markFailure(id, 'audio_stream_error');
          throw error;
        }
        return;
      }

      const upstreamStatus = Number.isInteger(upstream.status) ? upstream.status : 502;
      await discardUpstreamBody(upstream.body);

      if (upstreamStatus === 429) {
        sawRateLimit = true;
        const retryAfterMs = parseRetryAfter(responseHeader(upstream, 'retry-after'));
        keyPool.markRateLimited(id, retryAfterMs);
        earliestRetryAt = Math.min(earliestRetryAt, Date.now() + retryAfterMs);
        continue;
      }

      if (upstreamStatus === 401 || upstreamStatus === 402 || upstreamStatus === 403) {
        keyPool.markAuthFailure(id, upstreamStatus);
        continue;
      }

      keyPool.markFailure(id, upstreamStatus);
      const responseStatus = upstreamStatus >= 400 && upstreamStatus <= 599
        ? upstreamStatus
        : 502;
      throw new HttpError(
        responseStatus,
        'UPSTREAM_REQUEST_FAILED',
        'ElevenLabs rejected the text-to-speech request',
      );
    } finally {
      lifecycle.cleanup();
    }
  }

  if (sawRateLimit && Number.isFinite(earliestRetryAt)) {
    const retryAfterSeconds = Math.max(0, Math.ceil((earliestRetryAt - Date.now()) / 1000));
    throw new HttpError(
      429,
      'ALL_KEYS_RATE_LIMITED',
      'All available ElevenLabs keys are rate limited',
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }

  const coolingUntil = keyPool.snapshot().keys
    .filter((key) => key.status === 'cooldown' && key.cooldownUntil)
    .map((key) => Date.parse(key.cooldownUntil))
    .filter(Number.isFinite);
  if (coolingUntil.length > 0) {
    const retryAt = Math.min(...coolingUntil);
    const retryAfterSeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    throw new HttpError(
      429,
      'KEYS_IN_COOLDOWN',
      'All available ElevenLabs keys are in cooldown',
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }

  if (attempted.size > 0) {
    throw new HttpError(
      502,
      'ALL_KEYS_FAILED',
      'All configured ElevenLabs keys failed authentication or authorization',
    );
  }

  throw new HttpError(
    503,
    'NO_AVAILABLE_KEYS',
    'No available ElevenLabs API key is configured',
  );
}

const AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'audio/l16',
  'application/octet-stream',
  'application/wav',
]);

function safeAudioContentType(value, fallback = 'audio/mpeg') {
  if (typeof value !== 'string') return fallback;
  const base = value.split(';', 1)[0].trim().toLowerCase();
  if (!AUDIO_CONTENT_TYPES.has(base)) return fallback;
  if (base === 'audio/mp3') return 'audio/mpeg';
  if (base === 'audio/x-wav' || base === 'application/wav') return 'audio/wav';
  if (base === 'audio/l16') return 'audio/L16';
  if (base === 'application/octet-stream') return 'application/octet-stream';
  return base;
}

function contentTypeForOutput(outputFormat) {
  const format = String(outputFormat || '').toLowerCase();
  if (format.startsWith('opus')) return 'audio/ogg';
  if (format.startsWith('wav') || format.startsWith('pcm') || format.startsWith('alaw') || format.startsWith('ulaw')) {
    return format.startsWith('pcm') ? 'audio/L16' : 'audio/wav';
  }
  return 'audio/mpeg';
}

function hasDeclaredEmptyBody(response) {
  const value = responseHeader(response, 'content-length');
  return typeof value === 'string' && /^\d+$/.test(value.trim()) && Number(value) === 0;
}

async function proxyVoiceChanger(context) {
  const { req, res, keyPool, request, apiBaseUrl, fetchImpl, upstreamTimeoutMs } = context;
  const attempted = new Set();
  const multipart = createVoiceChangerMultipart(request);
  let sawRateLimit = false;
  let earliestRetryAt = Number.POSITIVE_INFINITY;

  while (true) {
    const id = keyPool.acquire(attempted);
    if (!id) {
      break;
    }

    attempted.add(id);
    keyPool.markRequest(id);
    const key = keyPool.keyFor(id);
    if (!key) {
      continue;
    }

    const endpoint = buildUpstreamEndpoint(
      apiBaseUrl,
      `v1/speech-to-speech/${encodeURIComponent(request.voiceId)}`,
    );
    endpoint.searchParams.set('output_format', request.outputFormat);

    const lifecycle = createUpstreamLifecycle(req, res, upstreamTimeoutMs);
    try {
      let upstream;
      try {
        upstream = await fetchImpl(endpoint.toString(), {
          method: 'POST',
          headers: {
            Accept: 'audio/*, application/json',
            'Content-Type': multipart.contentType,
            'xi-api-key': key,
          },
          body: multipart.body,
          signal: lifecycle.signal,
          redirect: 'error',
        });
      } catch {
        keyPool.markFailure(id, 'network_error');
        throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'ElevenLabs could not be reached');
      }

      const upstreamOk = upstream.ok ?? (
        Number.isInteger(upstream.status) && upstream.status >= 200 && upstream.status < 300
      );
      if (upstreamOk) {
        if (hasDeclaredEmptyBody(upstream)) {
          keyPool.markFailure(id, 'empty_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an empty audio response');
        }

        const upstreamContentType = responseHeader(upstream, 'content-type');
        if (!isAudioResponseType(upstreamContentType)) {
          await discardUpstreamBody(upstream.body);
          keyPool.markFailure(id, 'invalid_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned a non-audio response');
        }

        let audioBody;
        try {
          audioBody = await prepareAudioBody(upstream.body);
        } catch {
          keyPool.markFailure(id, 'audio_stream_error');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an unreadable audio response');
        }
        if (!audioBody) {
          keyPool.markFailure(id, 'empty_audio_response');
          throw new HttpError(502, 'INVALID_UPSTREAM_RESPONSE', 'ElevenLabs returned an empty audio response');
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', safeAudioContentType(upstreamContentType, contentTypeForOutput(request.outputFormat)));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'inline');
        try {
          await streamWebBody(audioBody, res);
          keyPool.markSuccess(id);
        } catch (error) {
          keyPool.markFailure(id, 'audio_stream_error');
          throw error;
        }
        return;
      }

      const upstreamStatus = Number.isInteger(upstream.status) ? upstream.status : 502;
      await discardUpstreamBody(upstream.body);

      if (upstreamStatus === 429) {
        sawRateLimit = true;
        const retryAfterMs = parseRetryAfter(responseHeader(upstream, 'retry-after'));
        keyPool.markRateLimited(id, retryAfterMs);
        earliestRetryAt = Math.min(earliestRetryAt, Date.now() + retryAfterMs);
        continue;
      }

      if (upstreamStatus === 401 || upstreamStatus === 402 || upstreamStatus === 403) {
        keyPool.markAuthFailure(id, upstreamStatus);
        continue;
      }

      keyPool.markFailure(id, upstreamStatus);
      const responseStatus = upstreamStatus >= 400 && upstreamStatus <= 599
        ? upstreamStatus
        : 502;
      throw new HttpError(
        responseStatus,
        'UPSTREAM_REQUEST_FAILED',
        'ElevenLabs rejected the voice changer request',
      );
    } finally {
      lifecycle.cleanup();
    }
  }

  if (sawRateLimit && Number.isFinite(earliestRetryAt)) {
    const retryAfterSeconds = Math.max(0, Math.ceil((earliestRetryAt - Date.now()) / 1000));
    throw new HttpError(
      429,
      'ALL_KEYS_RATE_LIMITED',
      'All available ElevenLabs keys are rate limited',
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }

  const coolingUntil = keyPool.snapshot().keys
    .filter((key) => key.status === 'cooldown' && key.cooldownUntil)
    .map((key) => Date.parse(key.cooldownUntil))
    .filter(Number.isFinite);
  if (coolingUntil.length > 0) {
    const retryAt = Math.min(...coolingUntil);
    const retryAfterSeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    throw new HttpError(
      429,
      'KEYS_IN_COOLDOWN',
      'All available ElevenLabs keys are in cooldown',
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }

  if (attempted.size > 0) {
    throw new HttpError(
      502,
      'ALL_KEYS_FAILED',
      'All configured ElevenLabs keys are unavailable',
    );
  }

  throw new HttpError(
    503,
    'NO_AVAILABLE_KEYS',
    'No available ElevenLabs API key is configured',
  );
}

function createUpstreamLifecycle(req, res, timeoutMs) {
  const controller = new AbortController();
  let cleaned = false;
  const abort = () => {
    if (!cleaned) controller.abort();
  };
  const onRequestAborted = () => abort();
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };

  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClose);
  if (req.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
    },
  };
}

async function prepareAudioBody(body) {
  if (!body) {
    return null;
  }

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    let first;
    try {
      first = await reader.read();
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the original read error.
      }
      throw error;
    }
    if (first.done || !first.value?.byteLength) {
      try {
        await reader.cancel();
      } catch {
        // An already-closed body needs no additional cleanup.
      }
      return null;
    }

    let sentFirst = false;
    return new ReadableStream({
      async pull(controller) {
        try {
          if (!sentFirst) {
            sentFirst = true;
            controller.enqueue(first.value);
            return;
          }
          const next = await reader.read();
          if (next.done) {
            controller.close();
          } else if (next.value?.byteLength) {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || !first.value?.byteLength) {
      if (typeof iterator.return === 'function') await iterator.return();
      return null;
    }
    return (async function* () {
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        if (next.value?.byteLength) yield next.value;
      }
    })();
  }

  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    return size > 0 ? body : null;
  }

  // A non-standard body cannot be safely peeked; the client-side empty-body
  // check remains the final guard for this uncommon embedding case.
  return body;
}

function createVoiceChangerMultipart(request) {
  const boundary = `----ElevenKeyFlow${randomUUID().replaceAll('-', '')}`;
  const chunks = [];
  const addTextPart = (name, value) => {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  };

  addTextPart('model_id', request.modelId);
  addTextPart('file_format', 'other');
  if (request.removeBackgroundNoise) {
    addTextPart('remove_background_noise', 'true');
  }

  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filenameForContentType(request.contentType)}"\r\nContent-Type: ${request.contentType}\r\n\r\n`,
    'utf8',
  ));
  chunks.push(request.audio);
  chunks.push(Buffer.from('\r\n', 'utf8'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function filenameForContentType(contentType) {
  const filenames = {
    'audio/aac': 'source.aac',
    'audio/flac': 'source.flac',
    'audio/mp4': 'source.m4a',
    'audio/mpeg': 'source.mp3',
    'audio/ogg': 'source.ogg',
    'audio/wav': 'source.wav',
    'audio/webm': 'source.webm',
    'audio/x-wav': 'source.wav',
  };
  return filenames[contentType] ?? 'source.audio';
}

function isAudioResponseType(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return true;
  }
  const contentType = value.split(';', 1)[0].trim().toLowerCase();
  return AUDIO_CONTENT_TYPES.has(contentType);
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

async function discardUpstreamBody(body) {
  if (!body) {
    return;
  }
  try {
    if (typeof body.cancel === 'function') {
      await body.cancel();
    } else if (typeof body.destroy === 'function') {
      body.destroy();
    } else if (typeof body.resume === 'function') {
      body.resume();
    }
  } catch {
    // The response is being discarded; cancellation errors are not actionable.
  }
}

function validateVoiceChangerRequest(searchParams, contentTypeHeader) {
  const voiceId = searchParams.get('voiceId') || searchParams.get('voice_id');
  if (!isSafeIdentifier(voiceId, 256)) {
    throw new HttpError(400, 'INVALID_VOICE_ID', 'voiceId must be a non-empty valid identifier');
  }

  const modelId = searchParams.get('modelId') || searchParams.get('model_id') || DEFAULT_VOICE_CHANGER_MODEL_ID;
  if (!isSafeIdentifier(modelId, 128)) {
    throw new HttpError(400, 'INVALID_MODEL_ID', 'modelId must be a non-empty valid identifier');
  }

  const outputFormat = searchParams.get('outputFormat') || searchParams.get('output_format') || 'mp3_44100_128';
  if (!ALLOWED_OUTPUT_FORMATS.has(outputFormat)) {
    throw new HttpError(400, 'INVALID_OUTPUT_FORMAT', 'Unsupported voice changer output format');
  }

  const removeBackgroundNoise = parseBooleanQuery(
    searchParams.get('removeBackgroundNoise') ?? searchParams.get('remove_background_noise'),
    false,
  );
  const contentType = normalizeUploadContentType(contentTypeHeader);
  if (!contentType) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload must be an audio file');
  }

  return {
    audio: null,
    contentType,
    modelId,
    outputFormat,
    removeBackgroundNoise,
    voiceId,
  };
}

function parseBooleanQuery(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new HttpError(400, 'INVALID_BOOLEAN', 'Boolean query parameters must be true or false');
}

function normalizeUploadContentType(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const contentType = value.split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'application/octet-stream') {
    return contentType;
  }
  return /^audio\/[a-z0-9.+-]+$/.test(contentType) ? contentType : null;
}

function validateTtsRequest(body) {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  }
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    throw new HttpError(400, 'INVALID_TEXT', 'text must be a non-empty string');
  }
  if (body.text.length > MAX_TTS_CHARACTERS) {
    throw new HttpError(413, 'TEXT_TOO_LONG', `text must not exceed ${MAX_TTS_CHARACTERS} characters`);
  }
  if (!isSafeIdentifier(body.voiceId)) {
    throw new HttpError(400, 'INVALID_VOICE_ID', 'voiceId must be a non-empty valid identifier');
  }

  const modelId = body.modelId ?? DEFAULT_MODEL_ID;
  if (!isSafeIdentifier(modelId)) {
    throw new HttpError(400, 'INVALID_MODEL_ID', 'modelId must be a non-empty valid identifier');
  }

  const outputFormat = body.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  if (!isSafeIdentifier(outputFormat, 80)) {
    throw new HttpError(400, 'INVALID_OUTPUT_FORMAT', 'outputFormat must be a non-empty valid identifier');
  }

  return {
    text: body.text,
    voiceId: body.voiceId,
    modelId,
    outputFormat,
  };
}

function isSafeIdentifier(value, maxLength = 256) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCrossSiteRequest(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return true;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    const requestHost = String(req.headers.host || '').toLowerCase();
    return originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:'
      ? true
      : originUrl.host.toLowerCase() !== requestHost;
  } catch {
    return true;
  }
}

function isAuthorized(req, dashboardToken) {
  if (!dashboardToken) {
    return true;
  }

  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') {
    return false;
  }
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorization);
  if (!match) {
    return false;
  }

  const suppliedHash = createHash('sha256').update(match[1], 'utf8').digest();
  const expectedHash = createHash('sha256').update(dashboardToken, 'utf8').digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function normalizeDashboardToken(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';
}

function parseEnvironmentKeys(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value.split(',').map((key) => key.trim()).filter(Boolean);
}

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return DEFAULT_RETRY_AFTER_MS;
  }

  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000))
      : MAX_RETRY_AFTER_MS;
  }

  // Retry-After's HTTP-date form is intentionally limited to the standard
  // IMF-fixdate syntax. This avoids treating arbitrary Date.parse strings as
  // a trusted cooldown instruction.
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT$/;
  if (httpDate.test(normalized)) {
    const retryAt = Date.parse(normalized);
    const baseNow = Number.isFinite(now) ? now : Date.now();
    if (Number.isFinite(retryAt)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAt - baseNow));
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function parsePort(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('PORT must be an integer from 0 to 65535');
  }
  return port;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError('ELEVENLABS_REQUEST_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('upstreamTimeoutMs must be a positive integer');
  }
  return value;
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === 'localhost') {
    return true;
  }
  const family = net.isIP(normalized);
  return family === 4
    ? normalized.startsWith('127.')
    : family === 6 && normalized === '::1';
}

function buildUpstreamEndpoint(apiBaseUrl, relativePath) {
  return new URL(relativePath.replace(/^\/+/, ''), `${apiBaseUrl}/`);
}

function stripTrailingSlash(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('apiBaseUrl must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('apiBaseUrl must be a valid HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('apiBaseUrl must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('apiBaseUrl must not contain credentials, query parameters, or fragments');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    process.stderr.write(`Unable to start ElevenLabs key router: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_API_BASE_URL,
  DEFAULT_HOST,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_PORT,
  createRequestHandler,
  createServer,
  parseEnvironmentKeys,
  parseRetryAfter,
  startServer,
  validateTtsRequest,
};
