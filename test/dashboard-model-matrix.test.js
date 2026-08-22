const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The dashboard is a plain browser script with no exports, so run it inside a
// VM against a deliberately permissive fake DOM. Anything the script touches
// that we do not care about resolves to a no-op; the handful of elements the
// matrix renderer writes to are real stubs we can read back.

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'dashboard.js'),
  'utf8'
);

function makeEl(tag = 'div') {
  const children = new Map();
  const el = {
    tagName: tag,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    options: [],
    selectedIndex: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    remove() {},
    closest: () => null,
    focus() {},
    querySelectorAll: () => [],
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(sel));
      return children.get(sel);
    }
  };
  // Any property the script reaches for that we did not define becomes a no-op
  // function, so unrelated init code cannot throw.
  return new Proxy(el, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
}

function runDashboard() {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const document = new Proxy(
    {
      getElementById,
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl(),
      body: makeEl('body'),
      documentElement: makeEl('html'),
      readyState: 'complete'
    },
    {
      get(t, p) {
        if (p in t) return t[p];
        if (typeof p === 'symbol') return undefined;
        return () => {};
      }
    }
  );

  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {}
  };

  const sandbox = {
    window: { location: { origin: 'http://localhost:20128' }, addEventListener() {} },
    document,
    localStorage: storage,
    sessionStorage: storage,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    Date,
    Math,
    JSON,
    alert() {},
    confirm: () => false,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    requestAnimationFrame: () => 0,
    URL,
    Blob: class {},
    FileReader: class {}
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: 'dashboard.js' });

  return { sandbox, elements, getElementById };
}

let ctx;
beforeEach(() => { ctx = runDashboard(); });

function fixture(overrides = {}) {
  return {
    accounts: [
      { id: 'a1', name: 'subscribed', enabled: true, catalogue: ['glm-5.2', 'gpt-oss:20b'] },
      { id: 'a2', name: 'free', enabled: true, catalogue: ['glm-5.2', 'gpt-oss:20b'] }
    ],
    probe: {
      startedAt: '2026-08-18T16:00:00.000Z',
      finishedAt: '2026-08-18T16:00:20.000Z',
      accountIds: ['a1', 'a2'],
      results: {
        'glm-5.2': { a1: 'available', a2: 'plan' },
        'gpt-oss:20b': { a1: 'available', a2: 'available' }
      },
      details: { 'a2|glm-5.2': 'this model requires a subscription' }
    },
    probeRunning: false,
    learned: [],
    ...overrides
  };
}

function matrix() {
  const table = ctx.getElementById('model-matrix');
  return {
    head: table.querySelector('thead').innerHTML,
    body: table.querySelector('tbody').innerHTML
  };
}

test('the script loads and exposes the matrix renderer', () => {
  assert.strictEqual(typeof ctx.sandbox.renderModelMatrix, 'function');
});

test('header lists every account plus a summary column', () => {
  ctx.sandbox.renderModelMatrix(fixture());
  const { head } = matrix();
  assert.match(head, /subscribed/);
  assert.match(head, /free/);
  assert.match(head, /Available on/);
});

test('a disabled account is marked in the header', () => {
  const data = fixture();
  data.accounts[1].enabled = false;
  ctx.sandbox.renderModelMatrix(data);
  assert.match(matrix().head, /free \(off\)/);
});

test('probe verdicts become the right cell classes', () => {
  ctx.sandbox.renderModelMatrix(fixture());
  const { body } = matrix();

  const rows = body.split('<tr').filter(r => r.includes('matrix-cell'));
  assert.strictEqual(rows.length, 2);

  const glm = rows.find(r => r.includes('glm-5.2'));
  assert.match(glm, /matrix-cell matrix-ok/);
  assert.match(glm, /matrix-cell matrix-plan/);

  const oss = rows.find(r => r.includes('gpt-oss:20b'));
  assert.strictEqual((oss.match(/matrix-ok/g) || []).length, 2);
  assert.ok(!oss.includes('matrix-plan'));
});

test('the summary badge counts available accounts', () => {
  ctx.sandbox.renderModelMatrix(fixture());
  const { body } = matrix();
  assert.match(body, /badge-green font-mono">1\/2</);
  assert.match(body, /badge-green font-mono">2\/2</);
});

test('the upstream reason is carried into the cell tooltip', () => {
  ctx.sandbox.renderModelMatrix(fixture());
  assert.match(matrix().body, /requires a subscription/);
});

test('a model no account can run is flagged and struck through', () => {
  const data = fixture();
  data.probe.results['kimi-k3'] = { a1: 'plan', a2: 'plan' };
  data.accounts.forEach(a => a.catalogue.push('kimi-k3'));

  ctx.sandbox.renderModelMatrix(data);
  const row = matrix().body.split('<tr').find(r => r.includes('kimi-k3'));
  assert.match(row, /matrix-row-none/);
  assert.match(row, /badge-gray font-mono">none</);
});

test('pairs with no probe data show as untested', () => {
  const data = fixture({ probe: null });
  ctx.sandbox.renderModelMatrix(data);
  const { body } = matrix();
  assert.match(body, /matrix-cell matrix-unknown/);
  assert.ok(!body.includes('matrix-ok'));
});

test('what live traffic learned fills in when no probe has run', () => {
  const data = fixture({
    probe: null,
    learned: [{ accountId: 'a2', model: 'glm-5.2', since: Date.now() }]
  });
  ctx.sandbox.renderModelMatrix(data);

  const row = matrix().body.split('<tr').find(r => r.includes('glm-5.2'));
  assert.match(row, /matrix-plan/, 'the learned rejection shows as a plan limit');
  assert.match(row, /matrix-unknown/, 'the untried account stays untested');
});

test('a probe verdict wins over the learned cache', () => {
  const data = fixture({
    learned: [{ accountId: 'a1', model: 'glm-5.2', since: Date.now() }]
  });
  ctx.sandbox.renderModelMatrix(data);

  const row = matrix().body.split('<tr').find(r => r.includes('glm-5.2'));
  // a1 probed available, so it must not be downgraded by the stale entry.
  assert.match(row, /matrix-cell matrix-ok/);
});

test('the meta line reports probe state', () => {
  ctx.sandbox.renderModelMatrix(fixture());
  assert.match(ctx.getElementById('probe-meta').textContent, /last probe:.*4 pairs/);

  ctx = runDashboard();
  ctx.sandbox.renderModelMatrix(fixture({ probe: null }));
  assert.strictEqual(ctx.getElementById('probe-meta').textContent, 'never probed');

  ctx = runDashboard();
  ctx.sandbox.renderModelMatrix(fixture({ probeRunning: true }));
  assert.strictEqual(ctx.getElementById('probe-meta').textContent, 'probing…');
});

test('no accounts yields an empty state rather than a broken table', () => {
  ctx.sandbox.renderModelMatrix({ accounts: [], probe: null, learned: [] });
  assert.match(matrix().body, /No accounts or models to show yet/);
});

test('model names are escaped', () => {
  const data = fixture({ probe: null });
  data.accounts[0].catalogue = ['<img src=x onerror=alert(1)>'];
  ctx.sandbox.renderModelMatrix(data);
  const { body } = matrix();
  assert.ok(!body.includes('<img src=x'));
  assert.match(body, /&lt;img/);
});

test('account model badges show the latest access status', () => {
  const account = {
    id: 'a1',
    name: 'free account',
    enabled: true,
    url: 'https://ollama.com',
    models: ['free-model', 'pro-model', 'limited-model', 'unknown-model']
  };
  const availability = {
    probe: {
      results: {
        'free-model': { a1: 'available' },
        'pro-model': { a1: 'plan' },
        'limited-model': { a1: 'failed' }
      }
    },
    learned: []
  };

  ctx.sandbox.renderAccounts([account], availability);
  const html = ctx.getElementById('accounts-list').innerHTML;

  assert.match(html, /free-model/);
  assert.match(html, /data-model-access="free"[^>]*>.*model-access-label">Free</);
  assert.match(html, /data-model-access="pro"[^>]*>.*model-access-label">Pro</);
  assert.match(html, /data-model-access="limit"[^>]*>.*model-access-label">Limit</);
  assert.match(html, /data-model-access="unknown"[^>]*>.*model-access-label">Untested</);
});

test('active model usage hides catalogue models with no requests', () => {
  const accounts = [
    { id: 'a1', models: ['catalogue-only-model', 'used-model'] }
  ];
  const modelStats = {
    'used-model': { totalRequests: 2, totalTokens: 120 },
    'idle-model': { totalRequests: 0, totalTokens: 0 }
  };

  ctx.sandbox.renderModelUsage(modelStats, accounts);
  const html = ctx.getElementById('models-list').innerHTML;

  assert.match(html, /used-model/);
  assert.doesNotMatch(html, /catalogue-only-model/);
  assert.doesNotMatch(html, /idle-model/);
});

test('health checks also refresh model availability', async () => {
  const calls = [];
  ctx.sandbox.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return { ok: true, json: async () => ({}) };
  };

  await ctx.sandbox.runHealthCheck();

  assert.deepStrictEqual(calls.map(call => `${call.method} ${call.url}`), [
    'POST http://localhost:20128/api/health-check',
    'POST http://localhost:20128/api/models/probe'
  ]);
});

test('the dashboard keeps active model usage but removes the separate availability matrix', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dashboard', 'index.html'),
    'utf8'
  );

  assert.match(html, /id="models-list"/);
  assert.doesNotMatch(html, /Model Availability/);
  assert.doesNotMatch(html, /id="probe-btn"/);
  assert.doesNotMatch(html, /id="model-matrix"/);
});

test('telemetry and latency panels share a responsive layout', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dashboard', 'index.html'),
    'utf8'
  );
  const layoutStart = html.indexOf('<div class="telemetry-layout">');
  const accountsSection = html.indexOf('<!-- Section: Account Controls & Routing -->', layoutStart);
  const layout = html.slice(layoutStart, accountsSection);

  assert.ok(layoutStart >= 0, 'telemetry layout wrapper should exist');
  assert.match(layout, /<section id="section-analytics"/);
  assert.match(layout, /<section id="section-distribution"/);
  assert.match(layout, /<section id="section-chart"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'style.css'), 'utf8'), /\.telemetry-layout/);
});
