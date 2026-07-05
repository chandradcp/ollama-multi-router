const { test } = require('node:test');
const assert = require('node:assert');
const { bumpUsage, readUsage, readRateLimit } = require('../src/providers');

test('bumpUsage counts within the same day/hour window', () => {
  const status = {};
  const now = new Date('2026-07-04T10:15:00Z');
  bumpUsage(status, now);
  bumpUsage(status, now);
  bumpUsage(status, new Date('2026-07-04T10:59:00Z')); // same day, same hour
  assert.strictEqual(readUsage(status, new Date('2026-07-04T10:30:00Z')).today, 3);
  assert.strictEqual(readUsage(status, new Date('2026-07-04T10:30:00Z')).hour, 3);
});

test('hour counter resets on a new hour, day counter keeps going', () => {
  const status = {};
  bumpUsage(status, new Date('2026-07-04T10:15:00Z'));
  bumpUsage(status, new Date('2026-07-04T11:05:00Z')); // new hour, same day
  const u = readUsage(status, new Date('2026-07-04T11:30:00Z'));
  assert.strictEqual(u.today, 2);
  assert.strictEqual(u.hour, 1);
});

test('day counter resets on a new day', () => {
  const status = {};
  bumpUsage(status, new Date('2026-07-04T23:59:00Z'));
  bumpUsage(status, new Date('2026-07-05T00:01:00Z')); // new day
  const u = readUsage(status, new Date('2026-07-05T00:05:00Z'));
  assert.strictEqual(u.today, 1);
  assert.strictEqual(u.hour, 1);
});

test('readUsage treats a stale window as zero', () => {
  const status = {};
  bumpUsage(status, new Date('2026-07-04T10:15:00Z'));
  // Reading a day later with no new activity => zero.
  const u = readUsage(status, new Date('2026-07-05T10:15:00Z'));
  assert.strictEqual(u.today, 0);
  assert.strictEqual(u.hour, 0);
});

test('readRateLimit returns null when not limited', () => {
  assert.strictEqual(readRateLimit({}), null);
  assert.strictEqual(readRateLimit({ rateLimit: null }), null);
});

test('readRateLimit reports remaining cooldown seconds', () => {
  const now = 1_000_000;
  const status = { rateLimit: { limitedUntil: now + 45_000, retryAfter: 60, at: 'x' } };
  const rl = readRateLimit(status, now);
  assert.strictEqual(rl.limited, true);
  assert.strictEqual(rl.retryAfter, 45);
});

test('readRateLimit expires once the cooldown passes', () => {
  const now = 1_000_000;
  const status = { rateLimit: { limitedUntil: now - 1, retryAfter: 60 } };
  assert.strictEqual(readRateLimit(status, now), null);
});
