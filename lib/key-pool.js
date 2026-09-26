'use strict';

const { randomUUID } = require('node:crypto');

const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 4096;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60_000;
const STATUS = Object.freeze({
  ACTIVE: 'active',
  COOLDOWN: 'cooldown',
  DISABLED: 'disabled',
});

class KeyPoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyPoolError';
    this.code = code;
    this.status = code === 'KEY_POOL_FULL' ? 409 : 400;
  }
}

class KeyPool {
  #records = [];
  #secrets = new Map();
  #secretValues = new Set();
  #cursor = 0;
  #maxKeys;
  #now;
  #idFactory;

  constructor(options = {}) {
    const maxKeys = options.maxKeys ?? MAX_KEYS;
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_KEYS) {
      throw new RangeError(`maxKeys must be an integer from 1 to ${MAX_KEYS}`);
    }

    this.#maxKeys = maxKeys;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;

    if (typeof this.#now !== 'function' || typeof this.#idFactory !== 'function') {
      throw new TypeError('now and idFactory must be functions');
    }
  }

  get size() {
    return this.#records.length;
  }

  get maxKeys() {
    return this.#maxKeys;
  }

  addKeys(input) {
    const values = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(values)) {
      throw new KeyPoolError('INVALID_KEYS', 'keys must be a string or an array of strings');
    }

    const unique = [];
    const seenInRequest = new Set();

    for (const value of values) {
      if (typeof value !== 'string') {
        throw new KeyPoolError('INVALID_KEY', 'Every ElevenLabs key must be a string');
      }

      const key = value.trim();
      if (
        key.length === 0 ||
        key.length > MAX_KEY_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(key)
      ) {
        throw new KeyPoolError('INVALID_KEY', 'Every ElevenLabs key must be a non-empty valid string');
      }

      if (!seenInRequest.has(key)) {
        seenInRequest.add(key);
        unique.push(key);
      }
    }

    const newKeys = unique.filter((key) => !this.#secretValues.has(key));
    if (this.#records.length + newKeys.length > this.#maxKeys) {
      throw new KeyPoolError(
        'KEY_POOL_FULL',
        `The key pool supports at most ${this.#maxKeys} keys`,
      );
    }

    let added = 0;
    for (const key of newKeys) {
      const id = this.#createUniqueId();
      const record = {
        id,
        label: `Key ${this.#records.length + 1}`,
        maskedKey: maskKey(key),
        status: STATUS.ACTIVE,
        cooldownUntil: null,
        lastUsedAt: null,
        successCount: 0,
        requestCount: 0,
        lastError: null,
      };

      this.#records.push(record);
      this.#secrets.set(id, key);
      this.#secretValues.add(key);
      added += 1;
    }

    return {
      added,
      keys: this.snapshot().keys,
    };
  }

  acquire(excludedIds = new Set()) {
    this.#refreshExpiredCooldowns();
    const size = this.#records.length;
    if (size === 0) {
      return null;
    }

    for (let offset = 0; offset < size; offset += 1) {
      const index = (this.#cursor + offset) % size;
      const record = this.#records[index];
      if (
        record.status === STATUS.ACTIVE &&
        !excludedIds.has(record.id)
      ) {
        this.#cursor = (index + 1) % size;
        return record.id;
      }
    }

    return null;
  }

  keyFor(id) {
    return this.#secrets.get(id) ?? null;
  }

  markRequest(id) {
    const record = this.#requireRecord(id);
    const usedAt = new Date(this.#now()).toISOString();
    record.requestCount += 1;
    record.lastUsedAt = usedAt;
    return usedAt;
  }

  markSuccess(id) {
    const record = this.#requireRecord(id);
    record.successCount += 1;
    record.status = STATUS.ACTIVE;
    record.cooldownUntil = null;
    record.lastError = null;
  }

  markRateLimited(id, cooldownMs) {
    const record = this.#requireRecord(id);
    const requestedDelay = Number(cooldownMs);
    const delay = Number.isFinite(requestedDelay)
      ? Math.min(MAX_COOLDOWN_MS, Math.max(0, requestedDelay))
      : DEFAULT_COOLDOWN_MS;
    const now = Number(this.#now());
    const safeNow = Number.isFinite(now) ? now : Date.now();
    record.status = STATUS.COOLDOWN;
    record.cooldownUntil = new Date(safeNow + delay).toISOString();
    record.lastError = 'Rate limited (429)';
  }

  markAuthFailure(id, statusCode) {
    const record = this.#requireRecord(id);
    record.status = STATUS.DISABLED;
    record.cooldownUntil = null;
    record.lastError = statusCode === 402
      ? 'Insufficient credits (402)'
      : statusCode === 403
        ? 'Access forbidden (403)'
        : 'Authentication failed (401)';
  }

  markFailure(id, statusCode) {
    const record = this.#requireRecord(id);
    record.status = STATUS.ACTIVE;
    record.cooldownUntil = null;
    record.lastError = `Upstream request failed (${statusCode})`;
  }

  reset() {
    for (const record of this.#records) {
      if (record.status === STATUS.DISABLED) {
        continue;
      }
      record.status = STATUS.ACTIVE;
      record.cooldownUntil = null;
      record.lastError = null;
    }
    this.#cursor = 0;
    return this.snapshot();
  }

  clear() {
    this.#records = [];
    this.#secrets.clear();
    this.#secretValues.clear();
    this.#cursor = 0;
  }

  snapshot() {
    this.#refreshExpiredCooldowns();
    const keys = this.#records.map((record) => ({ ...record }));
    const stats = {
      total: keys.length,
      available: keys.filter((record) => record.status === STATUS.ACTIVE).length,
      coolingDown: keys.filter((record) => record.status === STATUS.COOLDOWN).length,
      disabled: keys.filter((record) => record.status === STATUS.DISABLED).length,
    };

    return {
      keys,
      stats,
      maxKeys: this.#maxKeys,
    };
  }

  #createUniqueId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.#idFactory();
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new TypeError('idFactory must return a non-empty string of at most 128 characters');
      }
      if (!this.#secrets.has(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique key id');
  }

  #requireRecord(id) {
    const record = this.#records.find((candidate) => candidate.id === id);
    if (!record) {
      throw new KeyPoolError('KEY_NOT_FOUND', 'Key id was not found');
    }
    return record;
  }

  #refreshExpiredCooldowns() {
    const now = this.#now();
    for (const record of this.#records) {
      if (
        record.status === STATUS.COOLDOWN &&
        record.cooldownUntil &&
        Date.parse(record.cooldownUntil) <= now
      ) {
        record.status = STATUS.ACTIVE;
        record.cooldownUntil = null;
      }
    }
  }
}

function maskKey(key) {
  if (key.length <= 4) {
    return '\u2022\u2022\u2022\u2022';
  }
  return `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${key.slice(-4)}`;
}

module.exports = {
  KeyPool,
  KeyPoolError,
  MAX_KEYS,
  STATUS,
};
