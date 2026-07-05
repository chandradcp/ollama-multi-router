const { log, sleep } = require('./utils');

const DEFAULT_RETRY_CONFIG = {
  maxRetries: parseInt(process.env.MAX_RETRIES || '4', 10),
  baseDelay: 1000,
  maxDelay: 30000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  // Only transient network errors are retried against the *same* account.
  // Hard failures like ECONNREFUSED / ENOTFOUND mean the endpoint is down or
  // misconfigured — retrying the same host wastes backoff time, so we let the
  // cross-account fallback handle them immediately instead.
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']
};

function isRetryableError(err) {
  if (!err) return false;

  // Check error code
  if (err.code && DEFAULT_RETRY_CONFIG.retryableErrors.includes(err.code)) {
    return true;
  }

  // Check HTTP status
  if (err.response?.status) {
    return DEFAULT_RETRY_CONFIG.retryableStatuses.includes(err.response.status);
  }

  // Check timeout
  if (err.message && (
    err.message.includes('timeout') ||
    err.message.includes('ECONNRESET') ||
    err.message.includes('ETIMEDOUT')
  )) {
    return true;
  }

  return false;
}

function getDelay(attempt, config = {}) {
  const baseDelay = config.baseDelay || DEFAULT_RETRY_CONFIG.baseDelay;
  const maxDelay = config.maxDelay || DEFAULT_RETRY_CONFIG.maxDelay;

  // Exponential backoff with jitter
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponential;
  const delay = Math.min(exponential + jitter, maxDelay);
  return Math.round(delay);
}

async function executeWithRetry(operation, config = {}) {
  const maxRetries = config.maxRetries !== undefined ? config.maxRetries : DEFAULT_RETRY_CONFIG.maxRetries;
  const attempts = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const start = Date.now();
      const result = await operation();
      return {
        result,
        attempts: attempt + 1,
        duration: Date.now() - start
      };
    } catch (err) {
      attempts.push({
        attempt: attempt + 1,
        error: err.message,
        status: err.response?.status || null,
        code: err.code || null
      });

      const isLastAttempt = attempt >= maxRetries;
      const shouldRetry = isRetryableError(err) && !isLastAttempt;

      if (!shouldRetry) {
        throw err;
      }

      const delay = getDelay(attempt, config);
      log('warn', `Retry ${attempt + 1}/${maxRetries} after ${delay}ms due to ${err.message}`);
      await sleep(delay);
    }
  }

  throw new Error(`All retries failed: ${JSON.stringify(attempts)}`);
}

module.exports = {
  executeWithRetry,
  isRetryableError,
  getDelay,
  DEFAULT_RETRY_CONFIG
};
