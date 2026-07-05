const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { sleep } = require('../src/utils');
const cache = require('../src/cache'); // singleton

beforeEach(() => cache.clear());

test('set then get returns the cached value', () => {
  cache.set('POST', '/v1/chat/completions', { a: 1 }, { answer: 42 });
  assert.deepStrictEqual(cache.get('POST', '/v1/chat/completions', { a: 1 }), { answer: 42 });
});

test('get is a miss for a different body', () => {
  cache.set('POST', '/x', { a: 1 }, 'v');
  assert.strictEqual(cache.get('POST', '/x', { a: 2 }), null);
});

test('entries expire after their TTL', async () => {
  cache.set('GET', '/v1/models', {}, ['m'], 20);
  assert.notStrictEqual(cache.get('GET', '/v1/models', {}), null);
  await sleep(35);
  assert.strictEqual(cache.get('GET', '/v1/models', {}), null);
});

test('getStats tracks hits, misses and hit rate', () => {
  cache.set('GET', '/a', {}, 1);
  cache.get('GET', '/a', {});   // hit
  cache.get('GET', '/b', {});   // miss
  const s = cache.getStats();
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hitRate, '50.00');
});

test('clear empties the cache and resets counters', () => {
  cache.set('GET', '/a', {}, 1);
  cache.get('GET', '/a', {});
  cache.clear();
  const s = cache.getStats();
  assert.strictEqual(s.size, 0);
  assert.strictEqual(s.hits, 0);
  assert.strictEqual(s.misses, 0);
});
