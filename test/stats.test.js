const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const stats = require('../src/stats'); // singleton

beforeEach(() => stats.clear());

function rec(over = {}) {
  return {
    method: 'POST',
    path: '/v1/chat/completions',
    accountId: 'acct-1',
    model: 'gemma3:12b',
    duration: 100,
    status: 200,
    success: true,
    tokens: { input: 10, output: 5 },
    ...over
  };
}

test('recordRequest aggregates totals and success rate', () => {
  stats.recordRequest(rec());
  stats.recordRequest(rec({ success: false, status: 500 }));
  const all = stats.getAllStats();
  assert.strictEqual(all.totalRequests, 2);
  assert.strictEqual(all.successfulRequests, 1);
  assert.strictEqual(all.failedRequests, 1);
  assert.strictEqual(all.successRate, '50.00');
});

test('token totals sum input + output across requests', () => {
  stats.recordRequest(rec({ tokens: { input: 10, output: 5 } }));
  stats.recordRequest(rec({ tokens: { input: 3, output: 2 } }));
  assert.strictEqual(stats.getAllStats().totalTokens, 20);
});

test('per-account stats track success/failure and average duration', () => {
  stats.recordRequest(rec({ duration: 100 }));
  stats.recordRequest(rec({ duration: 300 }));
  const a = stats.getAccountStats('acct-1');
  assert.strictEqual(a.totalRequests, 2);
  assert.strictEqual(a.successfulRequests, 2);
  assert.strictEqual(a.avgDuration, 200);
});

test('cached requests are counted', () => {
  stats.recordRequest(rec({ cached: true }));
  stats.recordRequest(rec({ cached: false }));
  assert.strictEqual(stats.getAllStats().cachedRequests, 1);
});

test('model stats are grouped by model', () => {
  stats.recordRequest(rec({ model: 'gemma3:12b' }));
  stats.recordRequest(rec({ model: 'gpt-oss:20b' }));
  const all = stats.getAllStats();
  assert.ok(all.modelStats['gemma3:12b']);
  assert.ok(all.modelStats['gpt-oss:20b']);
  assert.strictEqual(all.modelStats['gemma3:12b'].totalRequests, 1);
});

test('clear resets everything', () => {
  stats.recordRequest(rec());
  stats.clear();
  const all = stats.getAllStats();
  assert.strictEqual(all.totalRequests, 0);
  assert.deepStrictEqual(all.accountStats, {});
});
