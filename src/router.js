const axios = require('axios');
const { log, sleep, normalizeBaseUrl } = require('./utils');
const { executeWithRetry } = require('./retry');
const {
  getEnabledAccounts,
  getGlobalRoutingStrategy,
  updateAccountStatus,
  incrementRequestCount,
  incrementErrorCount,
  recordAccountRateLimit,
  clearAccountRateLimit,
  isAccountRateLimited
} = require('./providers');

let roundRobinIndex = 0;

// Return enabled accounts as an ordered try-list according to the routing
// strategy. The first element is the primary pick; the rest are the fallback
// order. Every account appears exactly once so fallback always advances to a
// *different* account (previously priority/least-loaded kept retrying the same
// one, and round-robin could skip accounts).
function orderAccounts(strategy, enabledAccounts) {
  if (enabledAccounts.length === 0) {
    throw new Error('No enabled Ollama accounts available');
  }

  const accts = [...enabledAccounts];

  switch (strategy) {
    case 'least-loaded':
      return accts.sort((a, b) =>
        (a.status?.requestCount || 0) - (b.status?.requestCount || 0)
      );

    case 'priority':
      return accts.sort((a, b) =>
        (a.priority ?? Infinity) - (b.priority ?? Infinity)
      );

    case 'round-robin':
    default: {
      const start = roundRobinIndex % accts.length;
      roundRobinIndex = (roundRobinIndex + 1) % accts.length;
      return [...accts.slice(start), ...accts.slice(0, start)];
    }
  }
}

function selectAccount(strategy, enabledAccounts) {
  return orderAccounts(strategy, enabledAccounts)[0];
}

function getNextAccount(strategy = null) {
  const strat = strategy || getGlobalRoutingStrategy();
  return selectAccount(strat, getEnabledAccounts());
}

function getAllEnabledAccounts() {
  return getEnabledAccounts();
}

async function executeWithFallback(requestFn, maxRetries = null, strategy = null) {
  const retries = maxRetries || parseInt(process.env.MAX_RETRIES || '4', 10);
  const strat = strategy || getGlobalRoutingStrategy();
  const enabled = getAllEnabledAccounts();

  if (enabled.length === 0) {
    throw new Error('No enabled Ollama accounts available');
  }

  const ordered = orderAccounts(strat, enabled);

  // Deprioritize accounts currently in a 429 cooldown: try healthy accounts
  // first, and only fall back to rate-limited ones as a last resort (better
  // than failing outright if every account is limited).
  const ready = ordered.filter(a => !isAccountRateLimited(a.id));
  const cooling = ordered.filter(a => isAccountRateLimited(a.id));
  const tryOrder = [...ready, ...cooling];

  const limit = Math.min(retries, tryOrder.length);
  const attempts = [];

  for (let i = 0; i < limit; i++) {
    const account = tryOrder[i];

    try {
      incrementRequestCount(account.id);

      // Use per-account retry config
      const retryConfig = account.retry || {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000
      };

      const { result } = await executeWithRetry(
        () => requestFn(account),
        retryConfig
      );

      updateAccountStatus(account.id, { healthy: true, lastError: null });
      clearAccountRateLimit(account.id);
      return { result, account };
    } catch (err) {
      incrementErrorCount(account.id, err.message);
      updateAccountStatus(account.id, { healthy: false, lastError: err.message });

      // Surface Ollama rate-limiting (HTTP 429) per account so the dashboard
      // can show a cooldown badge.
      if (err.response && err.response.status === 429) {
        const retryAfter = parseInt(err.response.headers && err.response.headers['retry-after'], 10);
        recordAccountRateLimit(account.id, Number.isFinite(retryAfter) ? retryAfter : 60);
      }

      attempts.push({ account: account.id, error: err.message });
      log('warn', `Account ${account.id} failed after retries, trying next if available`, err.message);

      if (i < limit - 1) {
        await sleep(100);
      }
    }
  }

  throw new Error(`All Ollama accounts failed. Attempts: ${JSON.stringify(attempts)}`);
}

async function chatCompletion(account, ollamaBody, stream = false) {
  const url = `${normalizeBaseUrl(account.url)}/api/chat`;

  const response = await axios.post(url, ollamaBody, {
    headers: {
      'Authorization': `Bearer ${account.key}`,
      'Content-Type': 'application/json'
    },
    timeout: parseInt(process.env.REQUEST_TIMEOUT || '60000', 10),
    responseType: stream ? 'stream' : 'json'
  });

  if (stream) {
    return response.data;
  }

  return response.data;
}

async function listModels(account) {
  const url = `${normalizeBaseUrl(account.url)}/api/tags`;
  const response = await axios.get(url, {
    headers: {
      'Authorization': `Bearer ${account.key}`,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  return response.data.models || [];
}

module.exports = {
  orderAccounts,
  selectAccount,
  getNextAccount,
  getAllEnabledAccounts,
  executeWithFallback,
  chatCompletion,
  listModels
};
