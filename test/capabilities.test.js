const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  normalizeModel,
  markUnsupported,
  clearUnsupported,
  isKnownUnsupported,
  accountSupportsModel,
  isCapabilityError,
  listUnsupported,
  clearCapabilities
} = require('../src/capabilities');

beforeEach(() => clearCapabilities());

// ---------------------------------------------------------------------------
// normalizeModel
// ---------------------------------------------------------------------------
test('normalizeModel strips the ollama/ routing prefix', () => {
  assert.strictEqual(normalizeModel('ollama/glm-5.2'), 'glm-5.2');
  assert.strictEqual(normalizeModel('glm-5.2'), 'glm-5.2');
  assert.strictEqual(normalizeModel('  ollama/gpt-oss:20b  '), 'gpt-oss:20b');
});

test('normalizeModel tolerates empty and non-string input', () => {
  assert.strictEqual(normalizeModel(''), '');
  assert.strictEqual(normalizeModel(null), '');
  assert.strictEqual(normalizeModel(undefined), '');
  assert.strictEqual(normalizeModel(42), '');
});

test('normalizeModel only strips the prefix, not a matching substring', () => {
  assert.strictEqual(normalizeModel('my-ollama/model'), 'my-ollama/model');
});

// ---------------------------------------------------------------------------
// unsupported bookkeeping
// ---------------------------------------------------------------------------
test('a marked pair is known unsupported, and clearing forgets it', () => {
  markUnsupported('acct-a', 'glm-5.2');
  assert.strictEqual(isKnownUnsupported('acct-a', 'glm-5.2'), true);

  clearUnsupported('acct-a', 'glm-5.2');
  assert.strictEqual(isKnownUnsupported('acct-a', 'glm-5.2'), false);
});

test('marking is per account and per model, not global', () => {
  markUnsupported('acct-a', 'glm-5.2');
  assert.strictEqual(isKnownUnsupported('acct-b', 'glm-5.2'), false);
  assert.strictEqual(isKnownUnsupported('acct-a', 'gpt-oss:20b'), false);
});

test('the ollama/ prefix does not create a second entry', () => {
  markUnsupported('acct-a', 'ollama/glm-5.2');
  assert.strictEqual(isKnownUnsupported('acct-a', 'glm-5.2'), true);
  assert.strictEqual(isKnownUnsupported('acct-a', 'ollama/glm-5.2'), true);
});

test('an entry expires once the TTL has elapsed', () => {
  const t0 = 1_000_000;
  markUnsupported('acct-a', 'glm-5.2', t0);

  const almost = t0 + 6 * 60 * 60 * 1000 - 1;
  assert.strictEqual(isKnownUnsupported('acct-a', 'glm-5.2', almost), true);

  const past = t0 + 6 * 60 * 60 * 1000;
  assert.strictEqual(isKnownUnsupported('acct-a', 'glm-5.2', past), false);
});

test('marking ignores blank account or model', () => {
  markUnsupported('', 'glm-5.2');
  markUnsupported('acct-a', '');
  assert.deepStrictEqual(listUnsupported(), []);
});

// ---------------------------------------------------------------------------
// accountSupportsModel
// ---------------------------------------------------------------------------
test('an empty models list means no restriction', () => {
  const a = { id: 'acct-a', models: [] };
  assert.strictEqual(accountSupportsModel(a, 'anything-at-all'), true);
});

test('a populated models list acts as an allowlist', () => {
  const a = { id: 'acct-a', models: ['gpt-oss:20b', 'gemma4:31b'] };
  assert.strictEqual(accountSupportsModel(a, 'gpt-oss:20b'), true);
  assert.strictEqual(accountSupportsModel(a, 'glm-5.2'), false);
});

test('the allowlist matches across the ollama/ prefix on either side', () => {
  const a = { id: 'acct-a', models: ['ollama/gpt-oss:20b'] };
  assert.strictEqual(accountSupportsModel(a, 'gpt-oss:20b'), true);
  assert.strictEqual(accountSupportsModel(a, 'ollama/gpt-oss:20b'), true);
});

test('a recent 403 makes an otherwise-allowed model unsupported', () => {
  const a = { id: 'acct-a', models: [] };
  assert.strictEqual(accountSupportsModel(a, 'glm-5.2'), true);

  markUnsupported('acct-a', 'glm-5.2');
  assert.strictEqual(accountSupportsModel(a, 'glm-5.2'), false);
});

test('a request with no model named is allowed anywhere', () => {
  const a = { id: 'acct-a', models: ['gpt-oss:20b'] };
  assert.strictEqual(accountSupportsModel(a, null), true);
  assert.strictEqual(accountSupportsModel(a, ''), true);
});

test('a missing account supports nothing', () => {
  assert.strictEqual(accountSupportsModel(null, 'glm-5.2'), false);
});

// ---------------------------------------------------------------------------
// isCapabilityError
// ---------------------------------------------------------------------------
test('403 (plan excludes the model) counts as a capability rejection', () => {
  assert.strictEqual(isCapabilityError({ response: { status: 403 } }), true);
});

test('402 (extra-usage balance empty) counts as a capability rejection', () => {
  assert.strictEqual(isCapabilityError({ response: { status: 402 } }), true);
});

test('transient and unrelated failures are not capability rejections', () => {
  assert.strictEqual(isCapabilityError({ response: { status: 429 } }), false);
  assert.strictEqual(isCapabilityError({ response: { status: 500 } }), false);
  assert.strictEqual(isCapabilityError({ response: { status: 404 } }), false);
  assert.strictEqual(isCapabilityError({ response: { status: 401 } }), false);
  assert.strictEqual(isCapabilityError(new Error('socket hang up')), false);
  assert.strictEqual(isCapabilityError(null), false);
});

// ---------------------------------------------------------------------------
// listUnsupported
// ---------------------------------------------------------------------------
test('listUnsupported reports live entries and drops expired ones', () => {
  const t0 = 1_000_000;
  markUnsupported('acct-a', 'glm-5.2', t0);
  markUnsupported('acct-b', 'qwen3.5:397b', t0);

  const live = listUnsupported(t0 + 1000);
  assert.strictEqual(live.length, 2);
  assert.ok(live.some(e => e.accountId === 'acct-a' && e.model === 'glm-5.2'));

  const later = listUnsupported(t0 + 7 * 60 * 60 * 1000);
  assert.deepStrictEqual(later, []);
});

test('listUnsupported splits ids and models containing no separator ambiguity', () => {
  markUnsupported('acct-a', 'deepseek-v4-pro:0813');
  const [entry] = listUnsupported();
  assert.strictEqual(entry.accountId, 'acct-a');
  assert.strictEqual(entry.model, 'deepseek-v4-pro:0813');
});
