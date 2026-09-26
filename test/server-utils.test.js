'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseEnvironmentKeys, parseRetryAfter } = require('../server');

test('parses comma-separated environment keys and ignores empty values', () => {
  assert.deepEqual(
    parseEnvironmentKeys(' first-key, second-key ,, third-key '),
    ['first-key', 'second-key', 'third-key'],
  );
  assert.deepEqual(parseEnvironmentKeys(''), []);
});

test('parses Retry-After seconds and HTTP dates', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfter('12', now), 12_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5_000);
  assert.equal(parseRetryAfter('invalid', now), 60_000);
  assert.equal(parseRetryAfter('2.5', now), 60_000);
  assert.equal(parseRetryAfter('999999999999999999999999999999', now), 86_400_000);
});
