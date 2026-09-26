'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  INVALID_URL: 'Invalid request URL',
  CROSS_SITE_REQUEST_BLOCKED: 'Cross-site dashboard requests are not allowed',
  UNAUTHORIZED: 'Dashboard authentication required',
  INVALID_BODY: 'Request body is invalid',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  EMPTY_AUDIO_FILE: 'Uploaded audio file is empty',
  NOT_FOUND: 'Not found',
  KEYS_IN_COOLDOWN: 'All available ElevenLabs keys are in cooldown',
  ALL_KEYS_RATE_LIMITED: 'All available ElevenLabs keys are rate limited',
  ALL_KEYS_FAILED: 'All configured ElevenLabs keys are unavailable',
  NO_AVAILABLE_KEYS: 'No available ElevenLabs API key is configured',
  UPSTREAM_UNAVAILABLE: 'ElevenLabs could not be reached',
  INVALID_UPSTREAM_RESPONSE: 'ElevenLabs returned an invalid audio response',
  UPSTREAM_REQUEST_FAILED: 'ElevenLabs rejected the request',
  INVALID_VOICE_ID: 'voiceId must be a non-empty valid identifier',
  INVALID_MODEL_ID: 'modelId must be a non-empty valid identifier',
  INVALID_OUTPUT_FORMAT: 'Unsupported output format',
  INVALID_BOOLEAN: 'Boolean query parameters must be true or false',
  INVALID_TEXT: 'text must be a non-empty string',
  TEXT_TOO_LONG: 'The text is too long',
  INVALID_CONTENT_LENGTH: 'Invalid Content-Length header',
  PAYLOAD_TOO_LARGE: 'Request body is too large',
  REQUEST_ABORTED: 'The request was interrupted',
  REQUEST_BODY_ERROR: 'Could not read the request body',
  REQUEST_TIMEOUT: 'The request body timed out',
  INVALID_JSON: 'Request body must contain valid JSON',
  INVALID_PATH: 'Invalid URL path',
  FORBIDDEN_PATH: 'Path is not accessible',
  KEY_POOL_FULL: 'The key pool is full',
  INVALID_KEYS: 'keys must be a string or an array of strings',
  INVALID_KEY: 'Every ElevenLabs key must be a non-empty valid string',
  KEY_NOT_FOUND: 'Key id was not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  INTERNAL_ERROR: 'Internal server error',
  REQUEST_FAILED: 'Request failed',
});

const PUBLIC_ERROR_ALLOWED_MESSAGES = new Set([
  ...Object.values(PUBLIC_ERROR_MESSAGES),
  'ElevenLabs rejected the text-to-speech request',
  'ElevenLabs rejected the voice changer request',
]);

const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.headersSent) {
    throw new Error('Cannot send JSON after response headers have been sent');
  }

  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }
  res.end(body);
}

function sanitizeErrorHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const safe = {};
  const retryAfter = headers['Retry-After'] ?? headers['retry-after'];
  if (typeof retryAfter === 'string' && /^\d{1,10}$/.test(retryAfter.trim())) {
    safe['Retry-After'] = retryAfter.trim();
  }

  const challenge = headers['WWW-Authenticate'] ?? headers['www-authenticate'];
  if (typeof challenge === 'string' && /^Bearer(?:\s|$)/i.test(challenge.trim())) {
    safe['WWW-Authenticate'] = 'Bearer realm="ElevenLabs Key Router"';
  }

  const allow = headers.Allow ?? headers.allow;
  if (typeof allow === 'string' && /^[A-Za-z0-9, ]{1,100}$/.test(allow)) {
    safe.Allow = allow;
  }
  return safe;
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error?.status) ? error.status : 500;
  const safeStatus = statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
  const requestedCode = typeof error?.code === 'string' ? error.code : '';
  const code = Object.hasOwn(PUBLIC_ERROR_MESSAGES, requestedCode)
    ? requestedCode
    : (safeStatus >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  const requestedMessage = typeof error?.message === 'string' ? error.message : '';
  const message = PUBLIC_ERROR_ALLOWED_MESSAGES.has(requestedMessage)
    ? requestedMessage
    : (PUBLIC_ERROR_MESSAGES[code] || (safeStatus >= 500
      ? PUBLIC_ERROR_MESSAGES.INTERNAL_ERROR
      : PUBLIC_ERROR_MESSAGES.REQUEST_FAILED));
  const headers = error instanceof HttpError ? sanitizeErrorHeaders(error.headers) : {};

  sendJson(res, safeStatus, {
    error: {
      code,
      message,
    },
  }, headers);
}

function methodNotAllowed(res, allowedMethods, req) {
  req?.resume();
  const allow = [...new Set(allowedMethods)].join(', ');
  sendJson(res, 405, {
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
    },
  }, { Allow: allow });
}

function readBinary(req, options = {}) {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      req.resume();
      throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header');
    }
    if (Number(contentLength) > maxBytes) {
      req.resume();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload must not exceed ${maxBytes} bytes`);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload must not exceed ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };

    const onAborted = () => {
      fail(new HttpError(400, 'REQUEST_ABORTED', 'Upload was interrupted'));
    };

    const onError = () => {
      fail(new HttpError(400, 'REQUEST_BODY_ERROR', 'Could not read upload'));
    };

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new HttpError(408, 'REQUEST_TIMEOUT', 'Upload timed out')),
        options.timeoutMs,
      );
      timer.unref?.();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

async function readJson(req, options = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const contentType = req.headers['content-type'];
  const isJsonContentType = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType || '');
  if (!isJsonContentType) {
    req.resume();
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }

  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      req.resume();
      throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header');
    }
    if (Number(contentLength) > maxBytes) {
      req.resume();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `JSON body must not exceed ${maxBytes} bytes`);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `JSON body must not exceed ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        const raw = Buffer.concat(chunks, size).toString('utf8');
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Request body must contain valid JSON'));
      }
    };

    const onAborted = () => {
      fail(new HttpError(400, 'REQUEST_ABORTED', 'Request body was interrupted'));
    };

    const onError = () => {
      fail(new HttpError(400, 'REQUEST_BODY_ERROR', 'Could not read request body'));
    };

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new HttpError(408, 'REQUEST_TIMEOUT', 'Request body timed out')),
        options.timeoutMs,
      );
      timer.unref?.();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

async function serveStatic(req, res, publicDir, encodedPathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Invalid URL path');
  }

  if (
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    decodedPath.split('/').some((segment) => segment.startsWith('.'))
  ) {
    throw new HttpError(403, 'FORBIDDEN_PATH', 'Path is not accessible');
  }

  const root = path.resolve(publicDir);
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    throw error;
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  let requestedPath = path.resolve(realRoot, relativePath);
  if (!isWithinRoot(realRoot, requestedPath)) {
    throw new HttpError(403, 'FORBIDDEN_PATH', 'Path is not accessible');
  }

  let stats;
  try {
    stats = await fsp.stat(requestedPath);
    if (stats.isDirectory()) {
      requestedPath = path.join(requestedPath, 'index.html');
      stats = await fsp.stat(requestedPath);
    }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (error && error.code === 'EACCES') {
      throw new HttpError(403, 'FORBIDDEN_PATH', 'Path is not accessible');
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  }

  let realPath;
  try {
    realPath = await fsp.realpath(requestedPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    throw error;
  }

  if (!isWithinRoot(realRoot, realPath)) {
    throw new HttpError(403, 'FORBIDDEN_PATH', 'Path is not accessible');
  }

  const contentType = MIME_TYPES[path.extname(realPath).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', stats.size);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader(
    'Content-Security-Policy',
    contentType.startsWith('text/html') ? STATIC_CSP : "default-src 'none'; frame-ancestors 'none'",
  );

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(fs.createReadStream(realPath), res);
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function streamWebBody(body, res) {
  if (body && typeof body.getReader === 'function') {
    await pipeline(Readable.fromWeb(body), res);
    return;
  }

  if (
    body &&
    (typeof body.pipe === 'function' || typeof body[Symbol.asyncIterator] === 'function')
  ) {
    await pipeline(body, res);
    return;
  }

  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    await pipeline(Readable.from(body), res);
    return;
  }

  throw new Error('Upstream response did not include a readable body');
}

module.exports = {
  HttpError,
  applySecurityHeaders,
  isWithinRoot,
  methodNotAllowed,
  readBinary,
  readJson,
  sendError,
  sendJson,
  serveStatic,
  streamWebBody,
};
