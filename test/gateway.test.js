const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the module at a throwaway file so tests never touch config/gateway.json.
const TMP = path.join(os.tmpdir(), `gateway-test-${process.pid}.json`);
process.env.GATEWAY_CONFIG_PATH = TMP;

const gateway = require('../src/gateway');

function cleanup() {
  try { fs.unlinkSync(TMP); } catch {}
}

beforeEach(() => {
  cleanup();
  delete process.env.LOCAL_API_KEY;
});

after(cleanup);

test('loadGatewayConfig falls back to the default when nothing is set', () => {
  const key = gateway.loadGatewayConfig();
  assert.strictEqual(key, 'sk-local-router-change-me');
  assert.strictEqual(gateway.isDefaultKey(), true);
});

test('loadGatewayConfig uses LOCAL_API_KEY from env when no file exists', () => {
  process.env.LOCAL_API_KEY = 'sk-from-env';
  assert.strictEqual(gateway.loadGatewayConfig(), 'sk-from-env');
  assert.strictEqual(gateway.isDefaultKey(), false);
});

test('a persisted (generated) key takes precedence over env', () => {
  fs.writeFileSync(TMP, JSON.stringify({ localApiKey: 'sk-persisted' }));
  process.env.LOCAL_API_KEY = 'sk-from-env';
  assert.strictEqual(gateway.loadGatewayConfig(), 'sk-persisted');
});

test('generateLocalApiKey produces a prefixed random key and persists it', () => {
  const key = gateway.generateLocalApiKey();
  assert.match(key, /^sk-local-[0-9a-f]{48}$/);
  assert.strictEqual(gateway.getLocalApiKey(), key);
  // Persisted to disk and survives a reload.
  const onDisk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.strictEqual(onDisk.localApiKey, key);
  assert.strictEqual(gateway.loadGatewayConfig(), key);
});

test('generated keys are unique', () => {
  assert.notStrictEqual(gateway.generateLocalApiKey(), gateway.generateLocalApiKey());
});

test('setLocalApiKey accepts a valid custom key', () => {
  const key = gateway.setLocalApiKey('my-custom-strong-key');
  assert.strictEqual(key, 'my-custom-strong-key');
  assert.strictEqual(gateway.getLocalApiKey(), 'my-custom-strong-key');
});

test('setLocalApiKey rejects too-short or empty keys', () => {
  assert.throws(() => gateway.setLocalApiKey('short'), /at least 8 characters/);
  assert.throws(() => gateway.setLocalApiKey(''), /at least 8 characters/);
  assert.throws(() => gateway.setLocalApiKey(null), /at least 8 characters/);
});
