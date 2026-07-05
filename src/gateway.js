const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('./utils');

// Where a generated/overridden local API key is persisted. Overridable for
// tests so they never touch the real config file.
const GATEWAY_PATH = process.env.GATEWAY_CONFIG_PATH
  || path.join(__dirname, '..', 'config', 'gateway.json');

const DEFAULT_KEY = 'sk-local-router-change-me';

let localApiKey = DEFAULT_KEY;

// Precedence: a persisted (generated) key wins over the .env value, which wins
// over the built-in default. So `.env` seeds the initial key, and the dashboard
// "Generate" button can override it permanently without editing .env.
function loadGatewayConfig() {
  let persisted = null;
  try {
    if (fs.existsSync(GATEWAY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GATEWAY_PATH, 'utf8'));
      persisted = raw.localApiKey || null;
    }
  } catch (err) {
    log('warn', 'Failed to read gateway.json, ignoring', err.message);
  }

  localApiKey = persisted || process.env.LOCAL_API_KEY || DEFAULT_KEY;
  return localApiKey;
}

function getLocalApiKey() {
  return localApiKey;
}

function isDefaultKey() {
  return localApiKey === DEFAULT_KEY;
}

function setLocalApiKey(key) {
  if (!key || typeof key !== 'string' || key.trim().length < 8) {
    throw new Error('Local API key must be a string of at least 8 characters');
  }
  localApiKey = key.trim();
  try {
    fs.writeFileSync(GATEWAY_PATH, JSON.stringify({ localApiKey }, null, 2), 'utf8');
    log('info', 'Local API key updated and persisted to gateway.json');
  } catch (err) {
    log('error', 'Failed to persist local API key', err.message);
  }
  return localApiKey;
}

function generateLocalApiKey() {
  const key = 'sk-local-' + crypto.randomBytes(24).toString('hex');
  return setLocalApiKey(key);
}

module.exports = {
  loadGatewayConfig,
  getLocalApiKey,
  setLocalApiKey,
  generateLocalApiKey,
  isDefaultKey
};
