// Active per-account model availability probing.
//
// /api/tags lists the whole catalogue to every account regardless of plan, so
// the only way to know whether an account may actually run a model is to ask
// it to run one. This module sends the smallest possible generation request
// (one token) for each account/model pair and classifies the answer.
//
// Results feed the capability cache, so a probe run does double duty: it fills
// the dashboard matrix AND primes routing, sparing live traffic the discovery
// cost.

const axios = require('axios');
const { log, normalizeBaseUrl, stripTrailingSlash } = require('./utils');
const { markUnsupported, clearUnsupported, normalizeModel } = require('./capabilities');

// Probe verdicts.
const AVAILABLE = 'available';   // the account ran it
const PLAN = 'plan';             // 402/403 — plan or balance excludes it
const UNAVAILABLE = 'unavailable'; // 404 and friends — model not served here
const FAILED = 'failed';         // transient: timeout, 5xx, network

let lastRun = null; // { startedAt, finishedAt, results: {model: {accountId: verdict}} }
let running = false;

function classify(err) {
  const status = err && err.response && err.response.status;
  if (status === 402 || status === 403) return PLAN;
  if (status === 404 || status === 400) return UNAVAILABLE;
  return FAILED;
}

function planDetail(err) {
  const data = err && err.response && err.response.data;
  if (!data) return '';
  const raw = typeof data === 'string' ? data : data.error;
  if (!raw) return '';
  return String(raw).slice(0, 200);
}

async function probeOne(account, model, timeoutMs = 45000) {
  const isOpenAI = account.type === 'openai';
  const url = isOpenAI
    ? `${stripTrailingSlash(account.url)}/chat/completions`
    : `${normalizeBaseUrl(account.url)}/api/chat`;

  const body = isOpenAI
    ? { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }
    : { model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 1 } };

  try {
    await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${account.key}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    });
    clearUnsupported(account.id, model);
    return { verdict: AVAILABLE, detail: '' };
  } catch (err) {
    const verdict = classify(err);
    if (verdict === PLAN) {
      // Same signal the router learns from live traffic.
      markUnsupported(account.id, model);
    }
    return { verdict, detail: verdict === PLAN ? planDetail(err) : (err.message || '') };
  }
}

// Run `tasks` (thunks returning promises) at most `limit` at a time.
async function withConcurrency(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      await task();
    }
  });
  await Promise.all(workers);
}

// Probe every enabled account against the union of their advertised models.
// One request per pair, so keep concurrency modest to stay polite upstream.
async function probeAll(accounts, { concurrency = 4, timeoutMs = 45000 } = {}) {
  if (running) {
    const err = new Error('A model probe is already running');
    err.code = 'PROBE_BUSY';
    throw err;
  }
  running = true;

  const startedAt = new Date().toISOString();
  const results = {};
  const details = {};

  try {
    const models = new Set();
    accounts.forEach(a => (a.models || []).forEach(m => models.add(normalizeModel(m))));

    const tasks = [];
    for (const model of models) {
      results[model] = {};
      for (const account of accounts) {
        tasks.push(async () => {
          const { verdict, detail } = await probeOne(account, model, timeoutMs);
          results[model][account.id] = verdict;
          if (detail) details[`${account.id}|${model}`] = detail;
        });
      }
    }

    await withConcurrency(tasks, concurrency);

    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      accountIds: accounts.map(a => a.id),
      results,
      details
    };
    log('info', `Model probe finished: ${models.size} models across ${accounts.length} accounts`);
    return lastRun;
  } finally {
    running = false;
  }
}

function getLastRun() {
  return lastRun;
}

function isRunning() {
  return running;
}

// Test seam: forget any probe history.
function resetProbeState() {
  lastRun = null;
  running = false;
}

module.exports = {
  AVAILABLE,
  PLAN,
  UNAVAILABLE,
  FAILED,
  classify,
  probeOne,
  probeAll,
  withConcurrency,
  getLastRun,
  isRunning,
  resetProbeState
};
