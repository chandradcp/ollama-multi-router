const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeBaseUrl, generateId, sleep } = require('../src/utils');

test('normalizeBaseUrl strips a trailing /v1 (OpenAI-compat suffix)', () => {
  assert.strictEqual(normalizeBaseUrl('https://api.ollama.com/v1'), 'https://api.ollama.com');
  assert.strictEqual(normalizeBaseUrl('https://ollama.com/v1'), 'https://ollama.com');
});

test('normalizeBaseUrl strips trailing slashes', () => {
  assert.strictEqual(normalizeBaseUrl('https://ollama.com/'), 'https://ollama.com');
  assert.strictEqual(normalizeBaseUrl('https://ollama.com///'), 'https://ollama.com');
});

test('normalizeBaseUrl strips /v1 and trailing slash together', () => {
  assert.strictEqual(normalizeBaseUrl('https://api.ollama.com/v1/'), 'https://api.ollama.com');
});

test('normalizeBaseUrl is case-insensitive on /v1 and trims whitespace', () => {
  assert.strictEqual(normalizeBaseUrl('  https://host/V1  '), 'https://host');
});

test('normalizeBaseUrl leaves a plain host untouched', () => {
  assert.strictEqual(normalizeBaseUrl('https://ollama.com'), 'https://ollama.com');
});

test('normalizeBaseUrl does not strip a path that merely contains v1', () => {
  assert.strictEqual(normalizeBaseUrl('https://host/api/v1beta'), 'https://host/api/v1beta');
});

test('normalizeBaseUrl handles empty/null safely', () => {
  assert.strictEqual(normalizeBaseUrl(''), '');
  assert.strictEqual(normalizeBaseUrl(null), null);
  assert.strictEqual(normalizeBaseUrl(undefined), undefined);
});

test('generateId returns a non-empty string', () => {
  const id = generateId();
  assert.strictEqual(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.notStrictEqual(generateId(), generateId());
});

test('sleep resolves after the given delay', async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 18);
});
