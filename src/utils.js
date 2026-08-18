const winston = require('winston');
const path = require('path');
const fs = require('fs');

const LOG_REQUESTS = process.env.LOG_REQUESTS === 'true';
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (LOG_TO_FILE && !fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `[${timestamp}] [${level}]: ${message} ${metaStr}`;
      })
    )
  })
];

if (LOG_TO_FILE) {
  transports.push(
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'router.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  );
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports
});

function log(level, message, data = null) {
  if (data) {
    logger.log(level, message, data);
  } else {
    logger.log(level, message);
  }
}

function logRequest(method, path, accountId, status, duration, extra = {}) {
  if (!LOG_REQUESTS && !LOG_TO_FILE) return;
  const entry = {
    method,
    path,
    accountId: accountId || 'none',
    status: status || 'pending',
    durationMs: duration,
    ...extra
  };
  logger.info('request', entry);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

// Hosts that legitimately serve plain HTTP: a local Ollama daemon, a box on
// the LAN, a container on the same host. Everything else is a remote provider
// where http:// both leaks the API key in cleartext and breaks POSTs — the
// 301 to https downgrades the method to GET and the API answers 405.
function isLocalHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h.startsWith('127.')) return true;
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

// Upgrade http:// to https:// for remote hosts, leaving local addresses alone.
function upgradeInsecureUrl(url) {
  if (!url || !/^http:\/\//i.test(url)) return url;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return url;
  }
  if (isLocalHost(hostname)) return url;
  return url.replace(/^http:\/\//i, 'https://');
}

// Normalize an Ollama base URL so we can safely append native `/api/*` paths.
// Strips trailing slashes and a trailing `/v1` (OpenAI-compat suffix users
// often paste), because this router talks to Ollama's native API.
function normalizeBaseUrl(url) {
  if (!url) return url;
  return upgradeInsecureUrl(url.trim().replace(/\/+$/, '').replace(/\/v1$/i, ''));
}

// Normalize a base URL for a genuine OpenAI-compatible provider (Kimi Code,
// Moonshot, etc). Unlike Ollama, these providers' base URL conventionally
// *includes* the `/v1`-style path segment and endpoints hang directly off
// it (e.g. `.../coding/v1/chat/completions`) — so only trim trailing
// slashes, never strip a `/v1` suffix.
function stripTrailingSlash(url) {
  if (!url) return url;
  return upgradeInsecureUrl(url.trim().replace(/\/+$/, ''));
}

module.exports = {
  log,
  logRequest,
  sleep,
  generateId,
  normalizeBaseUrl,
  stripTrailingSlash,
  upgradeInsecureUrl
};
