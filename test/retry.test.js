const { test } = require('node:test');
const assert = require('node:assert');
const { isRetryableError, getDelay, executeWithRetry } = require('../src/retry');

test('isRetryableError: retryable HTTP statuses', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.strictEqual(isRetryableError({ response: { status } }), true, `status ${status}`);
  }
});

test('isRetryableError: non-retryable HTTP statuses', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.strictEqual(isRetryableError({ response: { status } }), false, `status ${status}`);
  }
});

test('isRetryableError: transient network codes are retryable', () => {
  assert.strictEqual(isRetryableError({ code: 'ETIMEDOUT' }), true);
  assert.strictEqual(isRetryableError({ code: 'ECONNRESET' }), true);
  assert.strictEqual(isRetryableError({ code: 'EAI_AGAIN' }), true);
});

test('isRetryableError: hard failures fail fast (fallback handles them)', () => {
  // Regression: ECONNREFUSED / ENOTFOUND used to be retried against the same
  // dead host, burning ~7s of backoff before falling back. They must not retry.
  assert.strictEqual(isRetryableError({ code: 'ECONNREFUSED' }), false);
  assert.strictEqual(isRetryableError({ code: 'ENOTFOUND' }), false);
});

test('isRetryableError: timeout messages are retryable, null is not', () => {
  assert.strictEqual(isRetryableError({ message: 'connect ETIMEDOUT 1.2.3.4:443' }), true);
  assert.strictEqual(isRetryableError(null), false);
  assert.strictEqual(isRetryableError({ message: 'bad request' }), false);
});

test('getDelay grows exponentially with jitter and stays under maxDelay', () => {
  const cfg = { baseDelay: 100, maxDelay: 100000 };
  for (let attempt = 0; attempt < 5; attempt++) {
    const exp = 100 * Math.pow(2, attempt);
    const d = getDelay(attempt, cfg);
    assert.ok(d >= exp, `attempt ${attempt}: ${d} >= ${exp}`);
    assert.ok(d <= exp * 1.3 + 1, `attempt ${attempt}: ${d} <= ${exp * 1.3}`);
  }
});

test('getDelay caps at maxDelay', () => {
  const d = getDelay(10, { baseDelay: 1000, maxDelay: 1500 });
  assert.strictEqual(d, 1500);
});

test('executeWithRetry returns immediately on success', async () => {
  let calls = 0;
  const { result, attempts } = await executeWithRetry(async () => { calls++; return 'ok'; }, { maxRetries: 3 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(attempts, 1);
  assert.strictEqual(calls, 1);
});

test('executeWithRetry retries a transient error then succeeds', async () => {
  let calls = 0;
  const { result, attempts } = await executeWithRetry(async () => {
    calls++;
    if (calls < 3) { const e = new Error('temp'); e.code = 'ETIMEDOUT'; throw e; }
    return 'done';
  }, { maxRetries: 5, baseDelay: 1, maxDelay: 5 });
  assert.strictEqual(result, 'done');
  assert.strictEqual(attempts, 3);
});

test('executeWithRetry throws immediately on a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(() => executeWithRetry(async () => {
    calls++;
    const e = new Error('nope'); e.response = { status: 400 }; throw e;
  }, { maxRetries: 5, baseDelay: 1 }), /nope/);
  assert.strictEqual(calls, 1);
});

test('executeWithRetry gives up after maxRetries on persistent transient errors', async () => {
  let calls = 0;
  await assert.rejects(() => executeWithRetry(async () => {
    calls++;
    const e = new Error('flaky'); e.code = 'ECONNRESET'; throw e;
  }, { maxRetries: 2, baseDelay: 1, maxDelay: 5 }), /flaky/);
  assert.strictEqual(calls, 3); // initial + 2 retries
});
