const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { log, normalizeBaseUrl, stripTrailingSlash } = require('./utils');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'accounts.json');
const USAGE_PATH = process.env.USAGE_STORE_PATH || path.join(__dirname, '..', 'config', 'usage.json');

let accounts = [];
let globalRoutingStrategy = 'round-robin';
let accountStatus = new Map();
let usageFlushTimer = null;

function loadAccounts() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(data);
    accounts = config.accounts || [];
    globalRoutingStrategy = config.routingStrategy || process.env.ROUTING_STRATEGY || 'round-robin';

    accounts.forEach(acc => {
      if (!accountStatus.has(acc.id)) {
        accountStatus.set(acc.id, {
          healthy: null,
          lastError: null,
          lastChecked: null,
          requestCount: 0,
          errorCount: 0,
          rateLimit: null
        });
      }
    });

    log('info', `Loaded ${accounts.length} Ollama accounts`);
    log('info', `Global routing strategy: ${globalRoutingStrategy}`);
  } catch (err) {
    log('error', 'Failed to load accounts config', err.message);
    accounts = [];
  }
}

// --- Per-account usage windows (Ollama doesn't expose quota via API, so we
// track how many requests each account has served today / this hour) --------
function dayKeyOf(now) { return now.toISOString().slice(0, 10); }   // YYYY-MM-DD
function hourKeyOf(now) { return now.toISOString().slice(0, 13); }  // YYYY-MM-DDTHH

// Increment the day/hour counters on a status object, rolling over the window
// when the date/hour changes. Pure w.r.t. the passed status + now.
function bumpUsage(status, now = new Date()) {
  const dk = dayKeyOf(now);
  const hk = hourKeyOf(now);
  if (!status.usage) status.usage = { dayKey: dk, dayCount: 0, hourKey: hk, hourCount: 0 };
  if (status.usage.dayKey !== dk) { status.usage.dayKey = dk; status.usage.dayCount = 0; }
  if (status.usage.hourKey !== hk) { status.usage.hourKey = hk; status.usage.hourCount = 0; }
  status.usage.dayCount++;
  status.usage.hourCount++;
  return status.usage;
}

// Read normalized usage, treating a stale window as zero.
function readUsage(status, now = new Date()) {
  const u = status.usage || {};
  return {
    today: u.dayKey === dayKeyOf(now) ? u.dayCount : 0,
    hour: u.hourKey === hourKeyOf(now) ? u.hourCount : 0
  };
}

// Read the active rate-limit state, or null once the cooldown has passed.
function readRateLimit(status, nowMs = Date.now()) {
  const rl = status.rateLimit;
  if (!rl || !rl.limitedUntil) return null;
  const remainingMs = rl.limitedUntil - nowMs;
  if (remainingMs <= 0) return null;
  return { limited: true, retryAfter: Math.ceil(remainingMs / 1000), since: rl.at || null };
}

function getAccounts() {
  return accounts.map(acc => {
    const raw = accountStatus.get(acc.id) || {};
    return {
      ...acc,
      status: {
        ...raw,
        usage: readUsage(raw),
        rateLimit: readRateLimit(raw)
      }
    };
  });
}

function getEnabledAccounts() {
  return accounts.filter(acc => acc.enabled !== false);
}

function getGlobalRoutingStrategy() {
  return globalRoutingStrategy;
}

function incrementRequestCount(id) {
  const status = accountStatus.get(id);
  if (status) {
    status.requestCount++;
    bumpUsage(status);
    scheduleUsageFlush();
  }
}

// Mark an account as rate-limited (HTTP 429) for `retryAfterSeconds`.
function recordAccountRateLimit(id, retryAfterSeconds) {
  const status = accountStatus.get(id);
  if (!status) return;
  const secs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 60;
  status.rateLimit = {
    limitedUntil: Date.now() + secs * 1000,
    retryAfter: secs,
    at: new Date().toISOString()
  };
  scheduleUsageFlush();
}

// Clear any active rate-limit flag (e.g. after a successful request).
function clearAccountRateLimit(id) {
  const status = accountStatus.get(id);
  if (status && status.rateLimit) {
    status.rateLimit = null;
    scheduleUsageFlush();
  }
}

// Is this account currently in a 429 cooldown?
function isAccountRateLimited(id) {
  return !!readRateLimit(accountStatus.get(id) || {});
}

// --- Usage persistence (survive restarts so "today" stays accurate) --------
function loadUsage() {
  try {
    if (!fs.existsSync(USAGE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    Object.entries(data).forEach(([id, saved]) => {
      const status = accountStatus.get(id);
      if (status && saved) {
        if (saved.usage) status.usage = saved.usage;
        if (saved.rateLimit) status.rateLimit = saved.rateLimit;
      }
    });
    log('info', 'Loaded per-account usage from disk');
  } catch (err) {
    log('warn', 'Failed to load usage store', err.message);
  }
}

function flushUsage() {
  try {
    const out = {};
    accountStatus.forEach((status, id) => {
      out[id] = { usage: status.usage || null, rateLimit: status.rateLimit || null };
    });
    fs.writeFileSync(USAGE_PATH, JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    log('warn', 'Failed to persist usage store', err.message);
  }
}

// Debounce disk writes so a burst of requests doesn't hammer the filesystem.
function scheduleUsageFlush() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    flushUsage();
  }, 3000);
  if (usageFlushTimer.unref) usageFlushTimer.unref();
}

function incrementErrorCount(id, error) {
  const status = accountStatus.get(id);
  if (status) {
    status.errorCount++;
    status.lastError = error;
  }
}

function updateAccountStatus(id, updates) {
  const status = accountStatus.get(id);
  if (status) {
    accountStatus.set(id, { ...status, ...updates });
  }
}

function extractRateLimit(headers) {
  if (!headers) return null;
  const h = {};
  Object.keys(headers).forEach(key => {
    h[key.toLowerCase()] = headers[key];
  });

  const limit = h['x-ratelimit-limit'] || h['ratelimit-limit'] || h['x-limit'] || null;
  const remaining = h['x-ratelimit-remaining'] || h['ratelimit-remaining'] || h['x-remaining'] || null;
  const reset = h['x-ratelimit-reset'] || h['ratelimit-reset'] || h['x-reset'] || null;
  const retryAfter = h['retry-after'] || null;

  if (!limit && !remaining) return null;

  return {
    limit: limit ? parseInt(limit, 10) : null,
    remaining: remaining ? parseInt(remaining, 10) : null,
    reset: reset ? parseInt(reset, 10) : null,
    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null
  };
}

async function healthCheckAccount(account) {
  try {
    // OpenAI-compatible accounts (Kimi Code, Moonshot, etc) expose their
    // catalog at /models (OpenAI shape: {data:[{id}]}) rather than Ollama's
    // native /api/tags ({models:[{name}]}).
    const url = account.type === 'openai'
      ? `${stripTrailingSlash(account.url)}/models`
      : `${normalizeBaseUrl(account.url)}/api/tags`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${account.key}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    account.models = account.type === 'openai'
      ? (response.data.data || []).map(m => m.id)
      : (response.data.models || []).map(m => m.name || m.model);

    const rateLimit = extractRateLimit(response.headers);

    updateAccountStatus(account.id, {
      healthy: true,
      lastError: null,
      lastChecked: new Date().toISOString(),
      rateLimit
    });

    return { success: true, models: account.models, rateLimit };
  } catch (err) {
    updateAccountStatus(account.id, {
      healthy: false,
      lastError: err.message,
      lastChecked: new Date().toISOString()
    });
    return { success: false, error: err.message };
  }
}

async function runHealthChecks() {
  log('info', 'Running health checks on all accounts');
  const checks = accounts.map(acc => healthCheckAccount(acc));
  await Promise.allSettled(checks);
}

function saveAccounts() {
  try {
    const data = JSON.stringify({ accounts, routingStrategy: globalRoutingStrategy }, null, 2);
    fs.writeFileSync(CONFIG_PATH, data, 'utf8');
    log('info', 'Accounts config saved');
  } catch (err) {
    log('error', 'Failed to save accounts config', err.message);
  }
}

function toggleAccount(id) {
  const account = accounts.find(acc => acc.id === id);
  if (account) {
    account.enabled = !account.enabled;
    saveAccounts();
    return { success: true, enabled: account.enabled };
  }
  return { success: false, error: 'Account not found' };
}

function updateRoutingStrategy(strategy) {
  if (!['round-robin', 'least-loaded', 'priority'].includes(strategy)) {
    return { success: false, error: 'Invalid strategy' };
  }
  globalRoutingStrategy = strategy;
  saveAccounts();
  return { success: true, strategy };
}

function saveAccount(data) {
  const existingIndex = accounts.findIndex(acc => acc.id === data.id);
  const accountData = {
    id: data.id,
    name: data.name,
    url: data.url,
    key: data.key,
    type: data.type === 'openai' ? 'openai' : 'ollama',
    enabled: data.enabled !== undefined ? data.enabled : true,
    models: existingIndex >= 0 ? accounts[existingIndex].models : [],
    priority: data.priority || 1,
    retry: data.retry || { maxRetries: 3, baseDelay: 1000, maxDelay: 10000 }
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = accountData;
    log('info', `Updated account: ${accountData.name} (${accountData.id})`);
  } else {
    accounts.push(accountData);
    log('info', `Added new account: ${accountData.name} (${accountData.id})`);

    if (!accountStatus.has(accountData.id)) {
      accountStatus.set(accountData.id, {
        healthy: null,
        lastError: null,
        lastChecked: null,
        requestCount: 0,
        errorCount: 0,
        rateLimit: null
      });
    }
  }

  saveAccounts();
  return { success: true, account: accountData };
}

function deleteAccount(id) {
  const index = accounts.findIndex(acc => acc.id === id);
  if (index < 0) return { success: false, error: 'Account not found' };

  const removed = accounts.splice(index, 1)[0];
  accountStatus.delete(id);

  saveAccounts();
  log('info', `Deleted account: ${removed.name} (${removed.id})`);
  return { success: true };
}

module.exports = {
  loadAccounts,
  getAccounts,
  getEnabledAccounts,
  getGlobalRoutingStrategy,
  updateAccountStatus,
  incrementRequestCount,
  incrementErrorCount,
  recordAccountRateLimit,
  clearAccountRateLimit,
  isAccountRateLimited,
  loadUsage,
  flushUsage,
  healthCheckAccount,
  runHealthChecks,
  toggleAccount,
  updateRoutingStrategy,
  saveAccount,
  deleteAccount,
  // exported for tests
  bumpUsage,
  readUsage,
  readRateLimit
};
