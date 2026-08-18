// Per-account model capability tracking.
//
// Ollama Cloud's /api/tags advertises the full catalogue to every account
// regardless of plan, so `account.models` tells us what exists, not what the
// account may actually run. A request for a subscription-only model lands on a
// free account as `403 this model requires a subscription`.
//
// Without this module the router discovers that the hard way on every single
// request: round-robin sends the call to an account that cannot serve it, the
// retry budget burns, and only the fallback to a subscribed account succeeds.
//
// So we remember the 403s. Entries expire (a plan can be upgraded) and a
// success clears them immediately, which keeps the cache self-healing rather
// than permanently writing an account off.

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// key: accountId + SEP + model -> timestamp of the rejection
const unsupported = new Map();

// NUL cannot occur in an account id or a model name, so it can never be
// mistaken for part of either half of the key.
const SEP = '\u0000';

function ttlMs() {
  const raw = parseInt(process.env.CAPABILITY_TTL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function keyOf(accountId, model) {
  return accountId + SEP + model;
}

// Strip the `ollama/` routing prefix so "ollama/glm-5.2" and "glm-5.2" are the
// same capability, whichever spelling the caller used.
function normalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const m = model.trim();
  return m.startsWith('ollama/') ? m.slice('ollama/'.length) : m;
}

// Record that `accountId` refused `model`. Called on an upstream 403.
function markUnsupported(accountId, model, nowMs = Date.now()) {
  const m = normalizeModel(model);
  if (!accountId || !m) return;
  unsupported.set(keyOf(accountId, m), nowMs);
}

// Forget a rejection — the account served the model, so any earlier 403 is
// stale (plan upgraded, upstream glitch resolved).
function clearUnsupported(accountId, model) {
  const m = normalizeModel(model);
  if (!accountId || !m) return;
  unsupported.delete(keyOf(accountId, m));
}

function isKnownUnsupported(accountId, model, nowMs = Date.now()) {
  const m = normalizeModel(model);
  if (!accountId || !m) return false;
  const at = unsupported.get(keyOf(accountId, m));
  if (at === undefined) return false;
  if (nowMs - at >= ttlMs()) {
    unsupported.delete(keyOf(accountId, m));
    return false;
  }
  return true;
}

// True when the account is worth trying for this model: its own allowlist
// permits it (an empty list means "no restriction") and we have not just seen
// it rejected. Unknown model => allowed, so a brand-new model is still tried.
function accountSupportsModel(account, model, nowMs = Date.now()) {
  if (!account) return false;
  const m = normalizeModel(model);
  if (!m) return true;

  const allow = Array.isArray(account.models) ? account.models : [];
  if (allow.length > 0) {
    const permitted = allow.some(x => normalizeModel(x) === m);
    if (!permitted) return false;
  }

  return !isKnownUnsupported(account.id, m, nowMs);
}

// Does this upstream error mean "this account may not run this model"?
//   403 - the plan does not include the model at all.
//   402 - the model bills against a separate extra-usage balance (kimi-k3 and
//         friends) and this account's balance is empty.
// Neither is fixable by retrying the same account, and both are per-model
// rather than per-account, so both belong in the capability cache. The TTL
// still applies, so topping up a balance is picked up without a restart.
function isCapabilityError(err) {
  const status = err && err.response && err.response.status;
  return status === 403 || status === 402;
}

// Snapshot for the dashboard / health endpoint.
function listUnsupported(nowMs = Date.now()) {
  const out = [];
  for (const [k, at] of unsupported.entries()) {
    if (nowMs - at >= ttlMs()) {
      unsupported.delete(k);
      continue;
    }
    const idx = k.indexOf(SEP);
    out.push({ accountId: k.slice(0, idx), model: k.slice(idx + 1), since: at });
  }
  return out;
}

function clearCapabilities() {
  unsupported.clear();
}

module.exports = {
  normalizeModel,
  markUnsupported,
  clearUnsupported,
  isKnownUnsupported,
  accountSupportsModel,
  isCapabilityError,
  listUnsupported,
  clearCapabilities
};
