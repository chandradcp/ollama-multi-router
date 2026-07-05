const { test } = require('node:test');
const assert = require('node:assert');

// --- Mock the providers module BEFORE requiring the router ---------------
// router.js destructures functions from ./providers at load time, so we must
// inject a fake into the require cache first. Node runs each test file in its
// own process, so this does not leak into other suites.
const providersPath = require.resolve('../src/providers');

let fakeAccounts = [];
let fakeStrategy = 'round-robin';
const statusUpdates = [];
const rateLimited = new Set();

require.cache[providersPath] = {
  id: providersPath,
  filename: providersPath,
  loaded: true,
  exports: {
    getEnabledAccounts: () => fakeAccounts,
    getGlobalRoutingStrategy: () => fakeStrategy,
    updateAccountStatus: (id, u) => statusUpdates.push({ id, ...u }),
    incrementRequestCount: () => {},
    incrementErrorCount: () => {},
    recordAccountRateLimit: () => {},
    clearAccountRateLimit: () => {},
    isAccountRateLimited: (id) => rateLimited.has(id)
  }
};

const { orderAccounts, executeWithFallback } = require('../src/router');

function accts(...defs) {
  // defs: [id, priority, requestCount]
  return defs.map(([id, priority = 1, requestCount = 0]) => ({
    id, priority, status: { requestCount }, retry: { maxRetries: 0, baseDelay: 1, maxDelay: 5 }
  }));
}

// ---------------------------------------------------------------------------
// orderAccounts: pure ordering logic
// ---------------------------------------------------------------------------
test('orderAccounts (priority) returns every account once, lowest priority first', () => {
  const list = accts(['c', 3], ['a', 1], ['b', 2]);
  const ordered = orderAccounts('priority', list).map(a => a.id);
  assert.deepStrictEqual(ordered, ['a', 'b', 'c']);
});

test('orderAccounts (least-loaded) sorts by request count ascending', () => {
  const list = accts(['busy', 1, 50], ['idle', 1, 1], ['mid', 1, 10]);
  const ordered = orderAccounts('least-loaded', list).map(a => a.id);
  assert.deepStrictEqual(ordered, ['idle', 'mid', 'busy']);
});

test('orderAccounts (round-robin) advances the primary each call, keeping all accounts', () => {
  const list = accts(['a'], ['b'], ['c']);
  const first = orderAccounts('round-robin', list).map(a => a.id);
  const second = orderAccounts('round-robin', list).map(a => a.id);
  const third = orderAccounts('round-robin', list).map(a => a.id);
  // Each rotation is a full permutation of all accounts...
  for (const perm of [first, second, third]) {
    assert.deepStrictEqual([...perm].sort(), ['a', 'b', 'c']);
  }
  // ...and the primary advances between calls.
  assert.notStrictEqual(first[0], second[0]);
  assert.notStrictEqual(second[0], third[0]);
});

test('orderAccounts throws when there are no enabled accounts', () => {
  assert.throws(() => orderAccounts('priority', []), /No enabled Ollama accounts/);
});

// ---------------------------------------------------------------------------
// executeWithFallback: cross-account fallback
// ---------------------------------------------------------------------------
test('executeWithFallback falls back to a DIFFERENT account when the primary fails', async () => {
  // Regression: priority/least-loaded used to retry the SAME account forever.
  fakeAccounts = accts(['dead', 1], ['live', 2]);
  fakeStrategy = 'priority';

  const tried = [];
  const requestFn = async (acc) => {
    tried.push(acc.id);
    if (acc.id === 'dead') { const e = new Error('down'); e.code = 'ENOTFOUND'; throw e; }
    return 'served';
  };

  const { result, account } = await executeWithFallback(requestFn, 4, 'priority');
  assert.strictEqual(result, 'served');
  assert.strictEqual(account.id, 'live');
  assert.deepStrictEqual(tried, ['dead', 'live']); // tried the dead one, then a distinct live one
});

test('executeWithFallback succeeds on the primary without touching others', async () => {
  fakeAccounts = accts(['a', 1], ['b', 2]);
  const tried = [];
  const { account } = await executeWithFallback(async (acc) => { tried.push(acc.id); return 'ok'; }, 4, 'priority');
  assert.strictEqual(account.id, 'a');
  assert.deepStrictEqual(tried, ['a']);
});

test('executeWithFallback throws when every account fails, listing attempts', async () => {
  fakeAccounts = accts(['a', 1], ['b', 2]);
  await assert.rejects(
    () => executeWithFallback(async (acc) => { const e = new Error('x-' + acc.id); e.code = 'ENOTFOUND'; throw e; }, 4, 'priority'),
    (err) => {
      assert.match(err.message, /All Ollama accounts failed/);
      assert.match(err.message, /x-a/);
      assert.match(err.message, /x-b/);
      return true;
    }
  );
});

test('executeWithFallback throws when no accounts are enabled', async () => {
  fakeAccounts = [];
  await assert.rejects(() => executeWithFallback(async () => 'x', 4, 'priority'), /No enabled Ollama accounts/);
});

test('executeWithFallback deprioritizes a rate-limited account', async () => {
  // Primary by priority is 'a', but it is in a 429 cooldown, so the router
  // should try the healthy 'b' first even though 'a' has higher priority.
  fakeAccounts = accts(['a', 1], ['b', 2]);
  rateLimited.clear();
  rateLimited.add('a');

  const tried = [];
  const { account } = await executeWithFallback(async (acc) => { tried.push(acc.id); return 'ok'; }, 4, 'priority');

  assert.strictEqual(account.id, 'b');
  assert.deepStrictEqual(tried, ['b']);
  rateLimited.clear();
});

test('executeWithFallback still tries a rate-limited account as a last resort', async () => {
  fakeAccounts = accts(['a', 1]);
  rateLimited.clear();
  rateLimited.add('a'); // the only account is limited — must still be attempted

  const { account } = await executeWithFallback(async () => 'ok', 4, 'priority');
  assert.strictEqual(account.id, 'a');
  rateLimited.clear();
});
