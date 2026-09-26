'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KeyPool, KeyPoolError, MAX_KEYS } = require('../lib/key-pool');

test('adds, masks, and de-duplicates keys without exposing secrets', () => {
  const pool = new KeyPool({
    idFactory: (() => {
      let next = 0;
      return () => `id-${++next}`;
    })(),
  });

  const firstSecret = 'test-secret-alpha';
  const secondSecret = 'test-secret-bravo';
  const result = pool.addKeys([firstSecret, ` ${firstSecret} `, secondSecret]);

  assert.equal(result.added, 2);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.keys.length, 2);
  assert.equal(snapshot.stats.available, 2);
  assert.equal(snapshot.maxKeys, MAX_KEYS);
  assert.ok(snapshot.keys[0].maskedKey.endsWith('lpha'));
  assert.ok(!JSON.stringify(snapshot).includes(firstSecret));
  assert.ok(!JSON.stringify(snapshot).includes(secondSecret));
  assert.equal(pool.keyFor(snapshot.keys[0].id), firstSecret);

  const duplicateResult = pool.addKeys(firstSecret);
  assert.equal(duplicateResult.added, 0);
  assert.equal(pool.size, 2);
});

test('enforces the ten-key limit atomically', () => {
  const pool = new KeyPool();
  pool.addKeys(Array.from({ length: MAX_KEYS }, (_, index) => `test-key-${index}`));

  assert.throws(
    () => pool.addKeys(['one-too-many']),
    (error) => error instanceof KeyPoolError && error.code === 'KEY_POOL_FULL',
  );
  assert.equal(pool.size, MAX_KEYS);
});

test('rotates past rate-limited and disabled keys and reset clears cooldowns only', () => {
  let now = Date.UTC(2026, 0, 1);
  const pool = new KeyPool({
    now: () => now,
    idFactory: (() => {
      let next = 0;
      return () => `rotation-id-${++next}`;
    })(),
  });
  pool.addKeys(['rate-limited-secret', 'auth-secret']);

  const firstId = pool.acquire();
  pool.markRequest(firstId);
  pool.markRateLimited(firstId, 2_000);
  assert.equal(pool.snapshot().keys[0].status, 'cooldown');
  assert.equal(pool.snapshot().keys[0].requestCount, 1);

  const secondId = pool.acquire();
  assert.notEqual(secondId, firstId);
  pool.markRequest(secondId);
  pool.markAuthFailure(secondId, 403);
  assert.equal(pool.snapshot().keys[1].status, 'disabled');
  assert.equal(pool.acquire(), null);

  now += 2_000;
  assert.equal(pool.acquire(), firstId);
  const reset = pool.reset();
  assert.deepEqual(reset.stats, {
    total: 2,
    available: 1,
    coolingDown: 0,
    disabled: 1,
  });
  assert.equal(reset.keys[0].lastError, null);
  assert.equal(reset.keys[1].lastError, 'Access forbidden (403)');
});

test('keeps the configured capacity immutable and caps pathological cooldowns', () => {
  const now = Date.UTC(2026, 0, 1);
  const pool = new KeyPool({ maxKeys: 2, now: () => now });
  pool.addKeys('first-key');
  assert.throws(() => {
    pool.maxKeys = MAX_KEYS + 1;
  }, TypeError);
  const id = pool.acquire();
  pool.markRateLimited(id, Number.MAX_SAFE_INTEGER);
  const cooldown = pool.snapshot().keys[0].cooldownUntil;
  assert.equal(cooldown, new Date(now + 24 * 60 * 60 * 1000).toISOString());
});

test('clear removes all keys and their server-side secrets', () => {
  const pool = new KeyPool({ idFactory: () => 'clear-id' });
  pool.addKeys('secret-to-clear');
  assert.equal(pool.keyFor('clear-id'), 'secret-to-clear');

  pool.clear();

  assert.equal(pool.size, 0);
  assert.equal(pool.keyFor('clear-id'), null);
  assert.deepEqual(pool.snapshot(), {
    keys: [],
    stats: { total: 0, available: 0, coolingDown: 0, disabled: 0 },
    maxKeys: MAX_KEYS,
  });
});
