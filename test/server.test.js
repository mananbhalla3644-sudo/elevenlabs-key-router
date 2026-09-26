'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../server');

const TTS_BODY = {
  text: 'Router failover test.',
  voiceId: 'JBFqnCBsd6RMkjVDRZzb',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_128',
};

async function withServer(options, callback) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback({ server, baseUrl });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function jsonRequest(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

function rawRequest(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(pathname, baseUrl),
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function stalledRequest(baseUrl, pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(pathname, baseUrl),
      { method: 'POST', headers, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          request.destroy();
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', (error) => {
      if (error.code === 'ECONNRESET') return;
      reject(error);
    });
    request.write('partial-body-never-finished');
  });
}

function upstreamResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

test('protects dashboard API routes and returns only masked key metadata', async () => {
  const secrets = ['secret-alpha', 'secret-bravo'];
  await withServer({ keys: secrets, dashboardToken: 'dashboard-secret' }, async ({ baseUrl }) => {
    const health = await jsonRequest(baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      authRequired: true,
      maxKeys: 10,
    });

    const unauthorized = await jsonRequest(baseUrl, '/api/keys');
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') || '', /Bearer/i);

    const authorized = await jsonRequest(baseUrl, '/api/keys', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.text();
    assert.equal(payload.includes(secrets[0]), false);
    assert.equal(payload.includes(secrets[1]), false);
    assert.equal(JSON.parse(payload).keys.length, 2);
  });
});

test('rotates past 429, 402, and 401 responses and streams the successful audio', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const key = options.headers['xi-api-key'];
    calls.push(key);
    if (key === 'limited-key') {
      return upstreamResponse(429, JSON.stringify({ detail: 'limited' }), {
        'retry-after': '2',
      });
    }
    if (key === 'depleted-key') {
      return upstreamResponse(402, JSON.stringify({ detail: 'no credits' }));
    }
    if (key === 'invalid-key') {
      return upstreamResponse(401, JSON.stringify({ detail: 'invalid' }));
    }
    if (key === 'forbidden-key') {
      return upstreamResponse(403, JSON.stringify({ detail: 'forbidden' }));
    }
    return new Response('mock-audio', {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  await withServer({
    keys: ['limited-key', 'depleted-key', 'invalid-key', 'forbidden-key', 'good-key'],
    fetchImpl,
  }, async ({ baseUrl, server }) => {
    const response = await jsonRequest(baseUrl, '/api/tts', {
      method: 'POST',
      body: JSON.stringify(TTS_BODY),
      headers: { Accept: 'audio/*' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), 'mock-audio');
    assert.deepEqual(calls, ['limited-key', 'depleted-key', 'invalid-key', 'forbidden-key', 'good-key']);

    const snapshot = server.keyPool.snapshot();
    assert.equal(snapshot.keys.find((key) => key.label === 'Key 1').status, 'cooldown');
    assert.match(
      snapshot.keys.find((key) => key.label === 'Key 2').lastError,
      /402/,
    );
    assert.equal(snapshot.keys.find((key) => key.label === 'Key 3').status, 'disabled');
    assert.equal(snapshot.keys.find((key) => key.label === 'Key 4').status, 'disabled');
    assert.equal(snapshot.keys.find((key) => key.label === 'Key 5').successCount, 1);
  });
});

test('does not replay an ambiguous 5xx response and wraps upstream auth failures', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers['xi-api-key']);
    return upstreamResponse(500, JSON.stringify({ detail: 'busy' }));
  };

  await withServer({ keys: ['only-key'], fetchImpl }, async ({ baseUrl }) => {
    const response = await jsonRequest(baseUrl, '/api/tts', {
      method: 'POST',
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'UPSTREAM_REQUEST_FAILED',
        message: 'ElevenLabs rejected the text-to-speech request',
      },
    });
    assert.deepEqual(calls, ['only-key']);
  });
});

test('returns 429 with Retry-After when every key is rate limited', async () => {
  const fetchImpl = async () => upstreamResponse(429, '{}', { 'retry-after': '9' });

  await withServer({ keys: ['one', 'two'], fetchImpl }, async ({ baseUrl }) => {
    const response = await jsonRequest(baseUrl, '/api/tts', {
      method: 'POST',
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.match(response.headers.get('retry-after') || '', /^\d+$/);
    assert.equal((await response.json()).error.code, 'ALL_KEYS_RATE_LIMITED');
  });
});

test('uploads an audio file to the voice changer and fails over with multipart forwarding', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const key = options.headers['xi-api-key'];
    calls.push({ key, url, options });
    if (key === 'limited-upload-key') {
      return upstreamResponse(429, '{}', { 'retry-after': '4' });
    }
    if (key === 'depleted-upload-key') {
      return upstreamResponse(402, '{}');
    }
    if (key === 'invalid-upload-key') {
      return upstreamResponse(401, '{}');
    }
    return new Response('mock-converted-audio', {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  await withServer({
    keys: ['limited-upload-key', 'depleted-upload-key', 'invalid-upload-key', 'good-upload-key'],
    fetchImpl,
  }, async ({ baseUrl, server }) => {
    const response = await fetch(
      `${baseUrl}/api/voice-changer?voiceId=voice_123&modelId=eleven_multilingual_sts_v2&outputFormat=mp3_44100_128&removeBackgroundNoise=true`,
      {
        method: 'POST',
        headers: {
          Accept: 'audio/*',
          'Content-Type': 'audio/mpeg',
        },
        body: Buffer.from('mock-source-audio'),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), 'mock-converted-audio');
    assert.deepEqual(calls.map((call) => call.key), [
      'limited-upload-key',
      'depleted-upload-key',
      'invalid-upload-key',
      'good-upload-key',
    ]);

    const firstRequest = calls[0];
    const endpoint = new URL(firstRequest.url);
    assert.equal(endpoint.pathname, '/v1/speech-to-speech/voice_123');
    assert.equal(endpoint.searchParams.get('output_format'), 'mp3_44100_128');
    assert.match(firstRequest.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);

    const multipart = Buffer.from(firstRequest.options.body).toString('utf8');
    assert.match(multipart, /name="audio"/);
    assert.match(multipart, /name="model_id"\r\n\r\neleven_multilingual_sts_v2/);
    assert.match(multipart, /name="file_format"\r\n\r\nother/);
    assert.match(multipart, /name="remove_background_noise"\r\n\r\ntrue/);
    assert.ok(multipart.includes('mock-source-audio'));

    const snapshot = server.keyPool.snapshot();
    assert.equal(snapshot.keys[0].status, 'cooldown');
    assert.match(snapshot.keys[1].lastError, /402/);
    assert.equal(snapshot.keys[2].status, 'disabled');
    assert.equal(snapshot.keys[3].successCount, 1);
  });
});

test('preserves a configured API base path and accepts the speech-to-speech alias', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = new URL(url);
    return new Response('alias-audio', {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  await withServer({
    keys: ['alias-key'],
    apiBaseUrl: 'https://mock.example.test/mock',
    fetchImpl,
  }, async ({ baseUrl }) => {
    const response = await fetch(
      `${baseUrl}/api/speech-to-speech?voiceId=voice_123&modelId=eleven_multilingual_sts_v2&outputFormat=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg' },
        body: Buffer.from('source-audio'),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'alias-audio');
    assert.equal(seenUrl.pathname, '/mock/v1/speech-to-speech/voice_123');
  });
});

test('rejects oversized voice uploads before proxying and handles empty upstream audio', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) {
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  await withServer({ keys: ['upload-key'], fetchImpl }, async ({ baseUrl }) => {
    const tooLarge = await rawRequest(
      baseUrl,
      '/api/voice-changer?voiceId=voice_123',
      {
        method: 'POST',
        headers: {
          Connection: 'close',
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(50 * 1024 * 1024 + 1),
        },
      },
    );
    assert.equal(tooLarge.status, 413);
    assert.equal(JSON.parse(tooLarge.body.toString('utf8')).error.code, 'PAYLOAD_TOO_LARGE');

    const emptyUpstream = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(emptyUpstream.status, 502);
    assert.equal((await emptyUpstream.json()).error.code, 'INVALID_UPSTREAM_RESPONSE');
    assert.equal(calls, 1);
  });
});

test('blocks cross-site API mutations and rejects non-JSON JSON routes', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('should-not-be-called', { status: 200 });
  };

  await withServer({ keys: ['safe-key'], fetchImpl }, async ({ baseUrl }) => {
    const crossSite = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error.code, 'CROSS_SITE_REQUEST_BLOCKED');

    const wrongType = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(wrongType.status, 415);
    assert.equal(calls, 0);
  });
});

test('sanitizes upstream audio content type parameters', async () => {
  const fetchImpl = async () => new Response('audio-body', {
    status: 200,
    headers: { 'content-type': 'audio/mpeg; secret=upstream-secret' },
  });

  await withServer({ keys: ['content-type-key'], fetchImpl }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TTS_BODY),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('content-type').includes('upstream-secret'), false);
    assert.equal(await response.text(), 'audio-body');
  });
});

test('rejects unsupported or empty voice changer uploads before contacting ElevenLabs', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('unexpected');
  };

  await withServer({ keys: ['upload-key'], fetchImpl }, async ({ baseUrl }) => {
    const unsupported = await fetch(
      `${baseUrl}/api/voice-changer?voiceId=voice_123`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not-audio',
      },
    );
    assert.equal(unsupported.status, 415);

    const empty = await fetch(
      `${baseUrl}/api/voice-changer?voiceId=voice_123`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg' },
        body: Buffer.alloc(0),
      },
    );
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'EMPTY_AUDIO_FILE');
    assert.equal(calls, 0);
  });
});

test('times out a stalled request body instead of holding the connection open', async () => {
  await withServer({ keys: ['timeout-key'], upstreamTimeoutMs: 150 }, async ({ baseUrl }) => {
    const result = await stalledRequest(baseUrl, '/api/keys', {
      'Content-Type': 'application/json',
      'Content-Length': '64',
    });

    assert.equal(result.status, 408);
    const payload = JSON.parse(result.body);
    assert.equal(payload.error.code, 'REQUEST_TIMEOUT');
    assert.equal(payload.error.message, 'The request body timed out');
  });
});

test('times out a stalled voice changer upload', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('unexpected');
  };

  await withServer(
    { keys: ['timeout-key'], upstreamTimeoutMs: 150, fetchImpl },
    async ({ baseUrl }) => {
      const result = await stalledRequest(
        baseUrl,
        '/api/voice-changer?voiceId=voice_123',
        {
          'Content-Type': 'audio/mpeg',
          'Content-Length': '4096',
        },
      );

      assert.equal(result.status, 408);
      assert.equal(JSON.parse(result.body).error.code, 'REQUEST_TIMEOUT');
      assert.equal(calls, 0);
    },
  );
});
