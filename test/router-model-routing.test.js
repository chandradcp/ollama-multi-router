const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// --- Mock the providers module BEFORE requiring the router ---------------
// Same approach as router.test.js: router.js destructures from ./providers at
// load time, so the fake has to be in the require cache first. The capabilities
// module is deliberately NOT mocked — these tests exercise the real one.
const providersPath = require.resolve('../src/providers');

let fakeAccounts = [];
let fakeStrategy = 'priority';
const statusUpdates = [];
const rateLimitCalls = [];

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
    recordAccountRateLimit: (id, seconds) => rateLimitCalls.push({ id, seconds }),
    clearAccountRateLimit: () => {},
    isAccountRateLimited: () => false
  }
};

const { executeWithFallback } = require('../src/router');
const { clearCapabilities, isKnownUnsupported } = require('../src/capabilities');

function account(id, priority, models) {
  return {
    id,
    priority,
    models,
    status: { requestCount: 0 },
    retry: { maxRetries: 0, baseDelay: 1, maxDelay: 5 }
  };
}

function forbidden() {
  const err = new Error('Request failed with status code 403');
  err.response = {
    status: 403,
    data: { error: 'this model requires a subscription, upgrade for access' }
  };
  return err;
}

beforeEach(() => {
  clearCapabilities();
  fakeStrategy = 'priority';
  statusUpdates.length = 0;
  rateLimitCalls.length = 0;
});

test('an account whose allowlist lacks the model is tried last', async () => {
  // `free` sorts first by priority but cannot serve glm-5.2.
  fakeAccounts = [
    account('free', 1, ['gpt-oss:20b', 'gemma4:31b']),
    account('subscribed', 2, [])
  ];

  const tried = [];
  const { account: used } = await executeWithFallback(
    acc => { tried.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    'glm-5.2'
  );

  assert.deepStrictEqual(tried, ['subscribed']);
  assert.strictEqual(used.id, 'subscribed');
});

test('priority order still wins when every account can serve the model', async () => {
  fakeAccounts = [
    account('free', 1, ['gpt-oss:20b']),
    account('subscribed', 2, [])
  ];

  const tried = [];
  await executeWithFallback(
    acc => { tried.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    'gpt-oss:20b'
  );

  assert.deepStrictEqual(tried, ['free']);
});

test('a 403 is remembered so the next request skips that account', async () => {
  fakeAccounts = [
    account('a', 1, []),
    account('b', 2, [])
  ];

  const first = [];
  await executeWithFallback(
    acc => {
      first.push(acc.id);
      return acc.id === 'a' ? Promise.reject(forbidden()) : Promise.resolve('ok');
    },
    4,
    null,
    'glm-5.2'
  );

  assert.deepStrictEqual(first, ['a', 'b'], 'first request discovers the 403');
  assert.strictEqual(isKnownUnsupported('a', 'glm-5.2'), true);

  const second = [];
  await executeWithFallback(
    acc => { second.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    'glm-5.2'
  );

  assert.deepStrictEqual(second, ['b'], 'second request goes straight to b');
});

test('the 403 verdict is scoped to that model only', async () => {
  fakeAccounts = [account('a', 1, []), account('b', 2, [])];

  await executeWithFallback(
    acc => (acc.id === 'a' ? Promise.reject(forbidden()) : Promise.resolve('ok')),
    4,
    null,
    'glm-5.2'
  );

  const tried = [];
  await executeWithFallback(
    acc => { tried.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    'gpt-oss:20b'
  );

  assert.deepStrictEqual(tried, ['a'], 'a is still first choice for a model it can serve');
});

test('a later success clears an earlier 403', async () => {
  fakeAccounts = [account('a', 1, []), account('b', 2, [])];

  await executeWithFallback(
    acc => (acc.id === 'a' ? Promise.reject(forbidden()) : Promise.resolve('ok')),
    4,
    null,
    'glm-5.2'
  );
  assert.strictEqual(isKnownUnsupported('a', 'glm-5.2'), true);

  // Only `a` is enabled now, so the request falls back to it despite the
  // verdict — and succeeding must clear the stale entry.
  fakeAccounts = [account('a', 1, [])];
  await executeWithFallback(() => Promise.resolve('ok'), 4, null, 'glm-5.2');

  assert.strictEqual(isKnownUnsupported('a', 'glm-5.2'), false);
});

test('when no account can serve the model, incapable ones are still attempted', async () => {
  fakeAccounts = [
    account('free-1', 1, ['gpt-oss:20b']),
    account('free-2', 2, ['gpt-oss:20b'])
  ];

  const tried = [];
  const { account: used } = await executeWithFallback(
    acc => { tried.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    'glm-5.2'
  );

  assert.deepStrictEqual(tried, ['free-1'], 'a last-resort attempt still happens');
  assert.strictEqual(used.id, 'free-1');
});

test('a request without a model name is unaffected by capability filtering', async () => {
  fakeAccounts = [account('a', 1, ['gpt-oss:20b']), account('b', 2, [])];
  markAllUnsupported();

  const tried = [];
  await executeWithFallback(
    acc => { tried.push(acc.id); return Promise.resolve('ok'); },
    4,
    null,
    null
  );

  assert.deepStrictEqual(tried, ['a']);
});

// ---------------------------------------------------------------------------
// A capability rejection is not an account fault
// ---------------------------------------------------------------------------
test('a 403 does not mark the account unhealthy', async () => {
  fakeAccounts = [account('a', 1, []), account('b', 2, [])];

  await executeWithFallback(
    acc => (acc.id === 'a' ? Promise.reject(forbidden()) : Promise.resolve('ok')),
    4,
    null,
    'glm-5.2'
  );

  const wentUnhealthy = statusUpdates.filter(u => u.id === 'a' && u.healthy === false);
  assert.deepStrictEqual(wentUnhealthy, [], 'a plan limit is not an outage');

  const note = statusUpdates.find(u => u.id === 'a' && u.lastError);
  assert.match(note.lastError, /not available on this plan/);
  assert.match(note.lastError, /glm-5\.2/);
});

test('a genuine failure still marks the account unhealthy', async () => {
  fakeAccounts = [account('a', 1, []), account('b', 2, [])];

  const boom = new Error('Request failed with status code 500');
  boom.response = { status: 500, data: { error: 'upstream exploded' } };

  await executeWithFallback(
    acc => (acc.id === 'a' ? Promise.reject(boom) : Promise.resolve('ok')),
    4,
    null,
    'glm-5.2'
  );

  const wentUnhealthy = statusUpdates.filter(u => u.id === 'a' && u.healthy === false);
  assert.strictEqual(wentUnhealthy.length, 1);
});

test('a 403 is not recorded as a rate limit', async () => {
  fakeAccounts = [account('a', 1, []), account('b', 2, [])];

  await executeWithFallback(
    acc => (acc.id === 'a' ? Promise.reject(forbidden()) : Promise.resolve('ok')),
    4,
    null,
    'glm-5.2'
  );

  assert.deepStrictEqual(rateLimitCalls, []);
});

function markAllUnsupported() {
  const { markUnsupported } = require('../src/capabilities');
  markUnsupported('a', 'glm-5.2');
  markUnsupported('b', 'glm-5.2');
}
