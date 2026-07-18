const API_BASE = window.location.origin;
let credentials = null;
let currentEditId = null;
let autoRefreshTimer = null;
let localKeyValue = 'default-insecure-key';
let lastStatValues = {};
let currentActivityLogs = [];
let currentActivityFilter = 'all';
let currentSearchQuery = '';

// Escape user-controlled fields before injecting into innerHTML to prevent stored XSS.
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAuthHeaders() {
  if (!credentials) return {};
  return {
    'Authorization': `Basic ${credentials}`
  };
}

// Thin JSON fetch helper used by the client/API-key management UI.
// Adds Basic auth, sets Content-Type for bodies (so express can parse them),
// and throws a readable error on non-2xx responses.
async function apiCall(path, method = 'GET', body = null) {
  const options = { method, headers: { ...getAuthHeaders() } };
  if (body != null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    const msg = data && (data.error || data.message);
    throw new Error(typeof msg === 'string' ? msg : `Request failed (HTTP ${response.status})`);
  }
  return data;
}

// --- Theme Switcher Persistence Engine ---
function initTheme() {
  const savedTheme = localStorage.getItem('routerTheme') || 'theme-cyan';
  applyTheme(savedTheme);

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme');
      applyTheme(theme);
      localStorage.setItem('routerTheme', theme);
      showToast(`🎨 Accent theme changed to ${btn.getAttribute('title')}!`, 'info', 2000);
    });
  });
}

function applyTheme(themeName) {
  document.documentElement.className = '';
  if (themeName && themeName !== 'theme-cyan') {
    document.documentElement.classList.add(themeName);
  }
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-theme') === themeName);
  });
}

// --- Smooth Number Count-Up Animation (Supporting Floats & Integers) ---
function animateValue(id, end, duration = 600, formatter = (v) => v.toLocaleString()) {
  const obj = document.getElementById(id);
  if (!obj) return;
  
  const isFloat = !Number.isInteger(end);
  const start = lastStatValues[id] != null ? lastStatValues[id] : 0;
  if (start === end) {
    obj.textContent = formatter(end);
    return;
  }

  lastStatValues[id] = end;
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    // Ease-out quad curve
    const current = start + (end - start) * (1 - (1 - progress) * (1 - progress));
    obj.textContent = formatter(isFloat ? current : Math.floor(current));
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      obj.textContent = formatter(end);
    }
  };
  window.requestAnimationFrame(step);
}

// --- Toast Notifications Engine ---
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" type="button">&times;</button>
  `;
  
  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    toast.remove();
  });

  container.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, duration);
}

// --- Navigation & Views ---
function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  setupScrollSpy();
}

function setupScrollSpy() {
  const navItems = document.querySelectorAll('.floating-nav .nav-item');
  const sections = document.querySelectorAll('main section[id]');

  window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(section => {
      const sectionTop = section.offsetTop;
      if (window.scrollY >= sectionTop - 180) {
        current = section.getAttribute('id');
      }
    });

    navItems.forEach(item => {
      item.classList.remove('active');
      if (item.getAttribute('href') === `#${current}`) {
        item.classList.add('active');
      }
    });
  }, { passive: true });
}

async function attemptLogin(username, password) {
  const cred = btoa(`${username}:${password}`);
  try {
    const response = await fetch(`${API_BASE}/api/accounts`, {
      headers: { 'Authorization': `Basic ${cred}` }
    });
    if (response.ok) {
      credentials = cred;
      showDashboard();
      showToast('Welcome to Ollama Multi Router v3.0 Pro Suite!', 'success');
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

// --- API Calls ---
async function fetchAccounts() {
  try {
    const response = await fetch(`${API_BASE}/api/accounts`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch accounts');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function fetchStatsData() {
  try {
    const response = await fetch(`${API_BASE}/api/stats`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch stats');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function fetchCacheData() {
  try {
    const response = await fetch(`${API_BASE}/api/cache`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch cache stats');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function clearStats() {
  try {
    const response = await fetch(`${API_BASE}/api/stats/clear`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error('Failed to clear stats');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function clearCache() {
  try {
    const response = await fetch(`${API_BASE}/api/cache/clear`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error('Failed to clear cache');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function exportConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config/export`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to export config');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ollama-router-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('Configuration exported successfully!', 'success');
  } catch (err) {
    showToast('Error exporting configuration: ' + err.message, 'error');
  }
}

async function importConfig(jsonContent) {
  try {
    const response = await fetch(`${API_BASE}/api/config/import`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonContent)
    });
    if (!response.ok) throw new Error('Failed to import configuration');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function toggleAccount(id) {
  try {
    const response = await fetch(`${API_BASE}/api/accounts/${id}/toggle`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error('Failed to toggle account');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function saveAccount(data) {
  try {
    const response = await fetch(`${API_BASE}/api/accounts`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error('Failed to save account');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function deleteAccount(id) {
  try {
    const response = await fetch(`${API_BASE}/api/accounts/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error('Failed to delete account');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function runHealthCheck() {
  try {
    const response = await fetch(`${API_BASE}/api/health-check`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error('Failed to run health check');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function pingAccountNode(id, btnElement) {
  const originalText = btnElement.textContent;
  btnElement.disabled = true;
  btnElement.textContent = '⏳ Pinging...';
  const startTime = Date.now();
  try {
    await runHealthCheck();
    const duration = Date.now() - startTime;
    showToast(`⚡ Node check complete in ${duration}ms!`, 'success');
    await refreshDashboard(true);
  } catch (err) {
    showToast(`❌ Ping failed: ${err.message}`, 'error');
  } finally {
    btnElement.disabled = false;
    btnElement.textContent = originalText;
  }
}

// --- Code Snippets ---
function updateGuideSnippets() {
  const base = `${API_BASE}/v1`;
  const key = localKeyValue || 'default-insecure-key';
  
  const modelSelect = document.getElementById('playground-model');
  let topModel = 'llama3.1:8b';
  if (modelSelect && modelSelect.options.length > 1 && modelSelect.options[1].value) {
    topModel = modelSelect.options[1].value;
  }

  ['python', 'node', 'cursor', 'hermes'].forEach(id => {
    const el = document.getElementById(`guide-base-${id}`);
    if (el) el.textContent = base;
  });

  ['curl', 'python', 'node', 'cursor', 'hermes'].forEach(id => {
    const el = document.getElementById(`guide-key-${id}`);
    if (el) el.textContent = key;
  });

  ['curl', 'python', 'node'].forEach(id => {
    const el = document.getElementById(`guide-model-${id}`);
    if (el) el.textContent = topModel;
  });
}

// --- Routing Strategy ---
async function fetchRoutingStrategy() {
  try {
    const response = await fetch(`${API_BASE}/api/routing-strategy`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch strategy');
    const data = await response.json();
    return data.strategy;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function updateRoutingStrategy(strategy) {
  try {
    const response = await fetch(`${API_BASE}/api/routing-strategy`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy })
    });
    if (!response.ok) throw new Error('Failed to update strategy');
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

// --- Dynamic SVG Sparkline Chart Generator ---
function renderLatencyChart(recentRequests) {
  const container = document.getElementById('latency-chart-container');
  if (!container) return;

  if (!recentRequests || recentRequests.length === 0) {
    container.innerHTML = '<div class="text-center py-8 text-muted font-mono">Waiting for traffic data to generate visual latency chart...</div>';
    return;
  }

  const data = [...recentRequests].slice(0, 30);
  const maxDuration = Math.max(...data.map(d => d.duration || 100), 100);
  
  const width = 800;
  const height = 200;
  const barWidth = Math.floor((width - (data.length - 1) * 6) / Math.max(data.length, 10));

  let barsHtml = '';
  data.forEach((req, idx) => {
    const duration = req.duration || 0;
    const barHeight = Math.max(Math.round((duration / maxDuration) * (height - 40)), 12);
    const x = idx * (barWidth + 6) + 20;
    const y = height - barHeight - 20;

    let fill = '#10b981'; // Green for 200 OK
    if (!req.success) fill = '#f43f5e'; // Red for error
    if (req.cached) fill = '#00f0ff'; // Cyan for cached hit

    const timeStr = new Date(req.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tooltipText = `Time: ${timeStr} | Model: ${req.model} | Latency: ${duration}ms | Status: ${req.success ? '200 OK' : '500 Error'} ${req.cached ? '(Cached)' : ''}`;

    barsHtml += `
      <g class="chart-bar" data-tooltip="${escapeHtml(tooltipText)}">
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="${fill}" opacity="0.85" />
        <text x="${x + barWidth / 2}" y="${height - 6}" fill="#94a3b8" font-size="9" text-anchor="middle" font-family="JetBrains Mono">${idx + 1}</text>
      </g>
    `;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
      <line x1="10" y1="${height - 20}" x2="${width - 10}" y2="${height - 20}" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
      <line x1="10" y1="${height / 2}" x2="${width - 10}" y2="${height / 2}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4" stroke-width="1" />
      <text x="12" y="16" fill="#6366f1" font-size="10" font-family="JetBrains Mono">Max Peak: ${maxDuration} ms</text>
      ${barsHtml}
    </svg>
  `;

  container.querySelectorAll('.chart-bar').forEach(bar => {
    bar.addEventListener('mouseenter', () => {
      const tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip font-mono';
      tooltip.textContent = bar.getAttribute('data-tooltip');
      container.appendChild(tooltip);
      const rect = bar.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      tooltip.style.left = `${Math.max(rect.left - cRect.left - 40, 10)}px`;
      tooltip.style.top = `${Math.max(rect.top - cRect.top - 35, 10)}px`;
    });
    bar.addEventListener('mouseleave', () => {
      const tooltip = container.querySelector('.chart-tooltip');
      if (tooltip) tooltip.remove();
    });
  });
}

// --- V4 Complex Analytics Render Functions ---
function renderModelDistribution(modelStats) {
  const container = document.getElementById('model-distribution');
  if (!container || !modelStats) return;

  const models = Object.keys(modelStats);
  if (models.length === 0) {
    container.innerHTML = '<div class="text-center text-muted font-mono py-4">No model traffic yet...</div>';
    return;
  }

  // Calculate total tokens across all models for percentage
  const totalTokens = models.reduce((sum, model) => sum + (modelStats[model].totalTokens || 0), 0);

  // Sort models by total tokens descending
  models.sort((a, b) => (modelStats[b].totalTokens || 0) - (modelStats[a].totalTokens || 0));

  let html = '';
  models.slice(0, 5).forEach(model => { // Show top 5 models
    const tokens = modelStats[model].totalTokens || 0;
    const percentage = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : 0;
    
    html += `
      <div class="model-dist-item">
        <div class="model-dist-label" title="${escapeHtml(model)}">${escapeHtml(model)}</div>
        <div class="model-dist-bar-bg">
          <div class="model-dist-bar-fill" style="width: ${percentage}%; background-color: var(--neon-cyan);"></div>
        </div>
        <div class="model-dist-value font-mono">${percentage}%</div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function renderHourlyHeatmap(hourlyStats) {
  const container = document.getElementById('hourly-heatmap');
  if (!container || !hourlyStats) return;

  const hours = Object.keys(hourlyStats).sort(); // Sort chronologically
  if (hours.length === 0) {
    container.innerHTML = '<div class="text-center text-muted font-mono py-4">No hourly traffic data...</div>';
    return;
  }

  // Find max traffic in an hour for scaling
  let maxRequests = 0;
  hours.forEach(h => {
    if (hourlyStats[h].requests > maxRequests) maxRequests = hourlyStats[h].requests;
  });

  // Generate last 24 hours (or available)
  let html = '';
  hours.slice(-24).forEach(hour => {
    const stat = hourlyStats[hour];
    const heightPercent = maxRequests > 0 ? Math.max((stat.requests / maxRequests) * 100, 5) : 5;
    
    // Parse hour label (e.g. "2026-07-04T02" -> "02:00")
    const dateObj = new Date(hour + ':00:00Z');
    const label = isNaN(dateObj.getTime()) ? hour : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const tooltip = `Hour: ${escapeHtml(label)} | Requests: ${stat.requests} | Success: ${stat.successful} | Tokens: ${stat.tokens}`;
    
    html += `
      <div class="heatmap-bar" 
           style="height: ${heightPercent}%;" 
           data-tooltip="${escapeHtml(tooltip)}">
      </div>
    `;
  });

  container.innerHTML = html;
}

function renderWorkloadBalance(accountStats, accounts) {
  const container = document.getElementById('workload-balance');
  const legend = document.getElementById('workload-legend');
  if (!container || !legend || !accountStats || !accounts) return;

  const activeAccounts = accounts.filter(a => a.enabled);
  if (activeAccounts.length === 0) {
    container.innerHTML = '<div class="text-center text-muted font-mono" style="width: 100%; padding-top: 2px;">No active nodes</div>';
    legend.innerHTML = '';
    return;
  }

  let totalRequests = 0;
  activeAccounts.forEach(acc => {
    const reqs = accountStats[acc.id] ? accountStats[acc.id].totalRequests : 0;
    totalRequests += reqs;
  });

  if (totalRequests === 0) {
    container.innerHTML = '<div class="text-center text-muted font-mono" style="width: 100%; padding-top: 2px;">Waiting for traffic...</div>';
    legend.innerHTML = '';
    return;
  }

  // Pre-defined colors for different nodes
  const colors = ['#00f0ff', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6'];

  let barHtml = '';
  let legendHtml = '';

  activeAccounts.forEach((acc, index) => {
    const reqs = accountStats[acc.id] ? accountStats[acc.id].totalRequests : 0;
    if (reqs > 0) {
      const percentage = (reqs / totalRequests) * 100;
      const color = colors[index % colors.length];
      
      const tooltip = `Node: ${escapeHtml(acc.name)} | Requests: ${reqs} (${percentage.toFixed(1)}%)`;
      
      barHtml += `
        <div class="workload-segment" 
             style="width: ${percentage}%; background-color: ${color};" 
             data-tooltip="${escapeHtml(tooltip)}">
        </div>
      `;
      
      legendHtml += `
        <div class="workload-legend-item">
          <div class="workload-color-dot" style="background-color: ${color};"></div>
          <span>${escapeHtml(acc.name)}</span>
        </div>
      `;
    }
  });

  container.innerHTML = barHtml;
  legend.innerHTML = legendHtml;
}

// --- V5 Multi-Tenant Clients Render Functions ---
async function renderClients() {
  const tbody = document.getElementById('clients-tbody');
  if (!tbody) return;

  try {
    const res = await apiCall('/api/clients');
    if (!res || !res.clients) return;

    if (res.clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No API clients found</td></tr>';
      return;
    }

    // Surface a real, working key in the code snippets / integration guide
    // instead of the placeholder.
    const primary = res.clients.find(c => c.enabled) || res.clients[0];
    if (primary && primary.key) {
      localKeyValue = primary.key;
      updateGuideSnippets();
    }

    let html = '';
    res.clients.forEach(c => {
      const statusBadge = c.enabled ? 
        '<span class="badge badge-green">Active</span>' : 
        '<span class="badge badge-red">Disabled</span>';
      
      html += `
        <tr>
          <td><strong class="text-main">${escapeHtml(c.name)}</strong></td>
          <td class="font-mono text-cyan" style="cursor: pointer;" onclick="copyClientKey('${escapeHtml(c.key)}')">${escapeHtml(c.key)} 📋</td>
          <td>${statusBadge}</td>
          <td style="text-align: right;">
            <button class="btn-secondary" onclick="toggleClient('${c.id}')">${c.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn-danger" onclick="deleteClient('${c.id}')">Delete</button>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (err) {
    console.error('Failed to load clients', err);
  }
}

// --- Render Functions ---
function renderStatus(status) {
  if (status === true) {
    return '<span class="status-dot healthy"></span> <span class="text-emerald font-semibold">Healthy</span>';
  } else if (status === false) {
    return '<span class="status-dot unhealthy"></span> <span class="text-rose font-semibold">Unhealthy</span>';
  }
  return '<span class="status-dot unknown"></span> <span class="text-muted">Unknown</span>';
}

function renderStats(accounts, statsData, cacheData) {
  if (!accounts) return;

  const total = accounts.length;
  const enabled = accounts.filter(a => a.enabled).length;
  const healthy = accounts.filter(a => a.status && a.status.healthy === true).length;
  const totalRequests = statsData && statsData.totalRequests != null ? statsData.totalRequests : accounts.reduce((sum, a) => sum + (a.status && a.status.requestCount || 0), 0);

  animateValue('total-accounts', total, 400, v => v);
  animateValue('enabled-accounts', enabled, 400, v => v);
  animateValue('healthy-accounts', healthy, 400, v => v);
  animateValue('total-requests', totalRequests, 600, v => v.toLocaleString());

  const successRateVal = parseInt(statsData && statsData.successRate || 0, 10);
  const avgDurationVal = parseInt(statsData && statsData.avgDuration || 0, 10);
  const totalTokensVal = parseInt(statsData && statsData.totalTokens || 0, 10);
  const hitRateVal = parseInt(cacheData && cacheData.hitRate || 0, 10);

  animateValue('success-rate', successRateVal, 500, v => `${v}%`);
  animateValue('avg-latency', avgDurationVal, 500, v => `${v} ms`);
  animateValue('total-tokens', totalTokensVal, 700, v => v.toLocaleString());
  animateValue('cache-hit-rate', hitRateVal, 500, v => `${v}%`);

  // Cloud API savings calculation ($5.00 per 1M tokens)
  const savingsVal = (totalTokensVal * 0.000005);
  animateValue('cloud-savings', savingsVal, 700, v => `$${v.toFixed(2)}`);

  // Throughput Velocity (Avg TPS across recent successful requests)
  let avgTpsVal = 0;
  if (statsData && statsData.recentRequests && statsData.recentRequests.length > 0) {
    const validReqs = statsData.recentRequests.filter(r => r.success && r.duration > 0 && r.tokens && (r.tokens.output || r.tokens.total));
    if (validReqs.length > 0) {
      const totalTps = validReqs.reduce((sum, r) => {
        const outTokens = r.tokens.output || r.tokens.total || 0;
        const durSec = r.duration / 1000;
        return sum + (outTokens / durSec);
      }, 0);
      avgTpsVal = Math.round(totalTps / validReqs.length);
    }
  }
  animateValue('avg-tps', avgTpsVal, 500, v => `${v} t/s`);
}

function renderAccounts(accounts) {
  const container = document.getElementById('accounts-list');

  if (!accounts || accounts.length === 0) {
    container.innerHTML = '<p class="empty-text">No accounts configured. Click "+ Add Account" to get started.</p>';
    return;
  }

  container.innerHTML = accounts.map(acc => {
    const usage = (acc.status && acc.status.usage) || { today: 0, hour: 0 };
    const rateLimit = acc.status && acc.status.rateLimit || null;

    let rateLimitHtml = '';
    if (rateLimit && rateLimit.limited) {
      rateLimitHtml = `
        <div class="rate-limit-info">
          <span class="rate-badge rate-danger">⛔ Rate Limited by Ollama</span>
          <span class="text-rose font-mono ml-2">retry ~${rateLimit.retryAfter}s</span>
        </div>
      `;
    }

    const safeId = escapeHtml(acc.id);
    const modelsText = acc.models && acc.models.length > 0
      ? acc.models.map(m => `<span class="badge badge-indigo font-mono">${escapeHtml(m)}</span>`).join(' ')
      : '<span class="text-muted">Not loaded</span>';

    return `
    <div class="account-item">
      <div class="account-info">
        <h3>
          ${escapeHtml(acc.name)}
          <span class="badge ${acc.enabled ? 'badge-green' : 'badge-gray'}">${acc.enabled ? 'Active' : 'Disabled'}</span>
          ${acc.type === 'openai' ? '<span class="badge badge-indigo">OpenAI-compatible</span>' : ''}
        </h3>
        <p class="font-mono text-muted">ID: ${safeId}</p>
        <p class="font-mono text-cyan">URL: ${escapeHtml(acc.url)}</p>
        <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center;">
          <span class="text-muted" style="font-size: 0.8rem;">Models:</span> ${modelsText}
        </div>
      </div>
      <div class="account-metrics">
        <div class="metric" title="Requests served by this account today (router-local count)">
          <span class="text-cyan">${usage.today}</span>
          Today
        </div>
        <div class="metric" title="Requests in the current hour">
          <span>${usage.hour}</span>
          This hour
        </div>
        <div class="metric">
          <span>${acc.status && acc.status.requestCount || 0}</span>
          Total
        </div>
        <div class="metric">
          <span>${acc.status && acc.status.errorCount || 0}</span>
          Errors
        </div>
        <div class="metric">
          <span>#${acc.priority || '1'}</span>
          Priority
        </div>
      </div>
      ${rateLimitHtml}
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="account-status">
          ${renderStatus(acc.status && acc.status.healthy)}
        </div>
        <button class="btn-ping" data-id="${safeId}" title="Check latency and health of this node">⚡ Ping Node</button>
      </div>
      <div class="account-actions">
        <button class="btn-toggle ${acc.enabled ? 'enabled' : 'disabled'}" data-id="${safeId}">
          ${acc.enabled ? '⏸ Disable' : '▶ Enable'}
        </button>
        <button class="btn-edit" data-id="${safeId}">✏️ Edit</button>
        <button class="btn-delete" data-id="${safeId}">🗑️ Delete</button>
      </div>
    </div>
  `}).join('');

  document.querySelectorAll('.btn-ping').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      pingAccountNode(id, btn);
    });
  });

  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      btn.disabled = true;
      btn.textContent = 'Updating...';
      const res = await toggleAccount(id);
      if (res) {
        showToast(`Account status updated!`, 'success');
        await refreshDashboard();
      } else {
        showToast('Failed to toggle account status', 'error');
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openEditModal(id);
    });
  });

  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (confirm('Are you sure you want to delete this Ollama account?')) {
        const res = await deleteAccount(id);
        if (res) {
          showToast('Account deleted successfully', 'success');
          await refreshDashboard();
        } else {
          showToast('Failed to delete account', 'error');
        }
      }
    });
  });
}

function renderModelUsage(modelStats, accounts) {
  const container = document.getElementById('models-list');
  const select = document.getElementById('playground-model');
  
  const allModels = new Set();
  if (accounts) {
    accounts.forEach(acc => {
      if (acc.models) acc.models.forEach(m => allModels.add(m));
    });
  }
  if (modelStats) {
    Object.keys(modelStats).forEach(m => allModels.add(m));
  }

  if (select && allModels.size > 0) {
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Select Active Model --</option>' + 
      Array.from(allModels).map(m => `<option value="${escapeHtml(m)}" ${m === currentVal ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    if (!currentVal && select.options.length > 1) {
      select.selectedIndex = 1;
    }
  }

  if (!container) return;

  if (allModels.size === 0) {
    container.innerHTML = '<p class="empty-text">No active models detected on connected accounts yet.</p>';
    return;
  }

  container.innerHTML = Array.from(allModels).map(modelName => {
    const stats = modelStats && modelStats[modelName] || { totalRequests: 0, totalTokens: 0 };
    return `
      <div class="model-pill">
        <span class="model-name">${escapeHtml(modelName)}</span>
        <div class="model-stats">
          <span>Req: <strong class="text-main">${stats.totalRequests || 0}</strong></span>
          <span>Tokens: <strong class="text-cyan">${(stats.totalTokens || 0).toLocaleString()}</strong></span>
          <span class="badge badge-cyan font-mono">Active</span>
        </div>
      </div>
    `;
  }).join('');

  updateGuideSnippets();
}

// --- Activity Feed Filter & Search Engine ---
function setupActivityFilters() {
  const searchInput = document.getElementById('activity-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.toLowerCase().trim();
      renderActivityFeed();
    });
  }

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentActivityFilter = btn.getAttribute('data-filter');
      renderActivityFeed();
    });
  });
}

function renderActivityFeed(recentRequests) {
  if (recentRequests) currentActivityLogs = recentRequests;
  const tbody = document.getElementById('activity-feed');
  if (!tbody) return;

  if (!currentActivityLogs || currentActivityLogs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">No recent requests logged yet. Connect Cursor or Hermes to start routing traffic.</td></tr>';
    return;
  }

  let filtered = [...currentActivityLogs].reverse();

  if (currentActivityFilter === 'success') {
    filtered = filtered.filter(r => r.success);
  } else if (currentActivityFilter === 'error') {
    filtered = filtered.filter(r => !r.success);
  } else if (currentActivityFilter === 'cached') {
    filtered = filtered.filter(r => r.cached);
  }

  if (currentSearchQuery) {
    filtered = filtered.filter(r => {
      const model = (r.model || '').toLowerCase();
      const path = (r.path || '').toLowerCase();
      const node = (r.accountId || '').toLowerCase();
      return model.includes(currentSearchQuery) || path.includes(currentSearchQuery) || node.includes(currentSearchQuery);
    });
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">No activity matching filter "${escapeHtml(currentActivityFilter)}" or query "${escapeHtml(currentSearchQuery)}".</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.slice(0, 100).map(req => {
    const timeStr = new Date(req.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const statusBadge = req.success 
      ? '<span class="badge badge-green">200 OK</span>' 
      : '<span class="badge badge-red">500 Error</span>';
    const cacheBadge = req.cached 
      ? '<span class="badge badge-cyan font-mono">⚡ CACHED</span>' 
      : '<span class="badge badge-gray font-mono">LIVE</span>';
    const totalTokens = ((req.tokens && req.tokens.input || 0) + (req.tokens && req.tokens.output || 0)).toLocaleString();

    return `
      <tr>
        <td class="font-mono text-muted">${timeStr}</td>
        <td>${statusBadge}</td>
        <td class="font-mono font-semibold text-main">${escapeHtml(req.model || 'unknown')}</td>
        <td class="font-mono text-cyan">${escapeHtml(req.method)} ${escapeHtml(req.path)}</td>
        <td class="font-mono text-indigo">${escapeHtml(req.accountId || 'router')}</td>
        <td class="font-mono">${req.duration || 0} ms</td>
        <td class="font-mono">${totalTokens} <span class="text-muted">(${req.tokens && req.tokens.input || 0} / ${req.tokens && req.tokens.output || 0})</span></td>
        <td>${cacheBadge}</td>
      </tr>
    `;
  }).join('');
}

// --- Auto-Refresh Engine ---
function setupAutoRefresh() {
  const select = document.getElementById('auto-refresh-interval');
  const indicator = document.getElementById('refresh-indicator');
  if (!select) return;

  if (autoRefreshTimer) clearInterval(autoRefreshTimer);

  const intervalMs = parseInt(select.value, 10);
  if (intervalMs > 0) {
    if (indicator) indicator.classList.add('active');
    autoRefreshTimer = setInterval(async () => {
      if (credentials && !document.hidden) {
        await refreshDashboard(true);
      }
    }, intervalMs);
  } else {
    if (indicator) indicator.classList.remove('active');
  }
}

async function refreshDashboard(silent = false) {
  const [accounts, statsData, cacheData] = await Promise.all([
    fetchAccounts(),
    fetchStatsData(),
    fetchCacheData()
  ]);

  if (accounts) {
    localStorage.setItem('cachedAccounts', JSON.stringify(accounts));
    renderStats(accounts, statsData, cacheData);
    renderAccounts(accounts);
  }
  
  if (statsData) {
    renderModelUsage(statsData.modelStats, accounts);
    renderActivityFeed(statsData.recentRequests);
    renderLatencyChart(statsData.recentRequests);
    
    // V4 Telemetry Renders
    renderModelDistribution(statsData.modelStats);
    renderHourlyHeatmap(statsData.hourlyStats);
    if (accounts) renderWorkloadBalance(statsData.accountStats, accounts);
  }

  await renderClients();

  if (!silent && accounts) {
    showToast('Dashboard telemetry refreshed!', 'success', 2000);
  }
}

// --- Modal Controls ---
function openModal() {
  document.getElementById('account-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('account-modal').classList.add('hidden');
  document.getElementById('account-form').reset();
  currentEditId = null;
}

function openEditModal(id) {
  const accounts = JSON.parse(localStorage.getItem('cachedAccounts') || '[]');
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;

  currentEditId = id;
  document.getElementById('modal-title').textContent = 'Edit Account';
  document.getElementById('form-account-id').value = acc.id;
  document.getElementById('form-type').value = acc.type || 'ollama';
  document.getElementById('form-name').value = acc.name;
  document.getElementById('form-url').value = acc.url;
  document.getElementById('form-key').value = acc.key;
  document.getElementById('form-priority').value = acc.priority || 1;

  openModal();
}

function openAddModal() {
  currentEditId = null;
  document.getElementById('modal-title').textContent = 'Add New Account';
  document.getElementById('form-account-id').value = '';
  document.getElementById('form-type').value = 'ollama';
  document.getElementById('form-name').value = '';
  document.getElementById('form-url').value = '';
  document.getElementById('form-key').value = '';
  document.getElementById('form-priority').value = 1;

  openModal();
}

// --- Initialize App ---
async function init() {
  initTheme();
  setupActivityFilters();
  showLogin();

  const safeBind = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };

  safeBind('login-btn', 'click', async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');

    errorEl.textContent = '';
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Authenticating...';

    const success = await attemptLogin(username, password);
    btn.disabled = false;
    btn.textContent = 'Login to Dashboard';

    if (success) {
      await refreshDashboard(true);
      const strategy = await fetchRoutingStrategy();
      if (strategy) {
        document.getElementById('routing-strategy').value = strategy;
      }
      setupAutoRefresh();
    } else {
      errorEl.textContent = '❌ Invalid credentials. Please try again.';
    }
  });

  safeBind('password', 'keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('login-btn').click();
    }
  });

  safeBind('logout-btn', 'click', () => {
    credentials = null;
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = '';
    showLogin();
    showToast('Logged out successfully.', 'info');
  });

  safeBind('refresh-btn', 'click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.textContent = '🔄 Refreshing...';
    await refreshDashboard();
    btn.disabled = false;
    btn.textContent = '🔄 Refresh Status';
  });

  safeBind('health-check-btn', 'click', async () => {
    const btn = document.getElementById('health-check-btn');
    btn.disabled = true;
    btn.textContent = '🏥 Checking...';
    showToast('Running health checks on all Ollama nodes...', 'info');
    await runHealthCheck();
    await refreshDashboard(true);
    btn.disabled = false;
    btn.textContent = '🏥 Run Health Check';
    showToast('Health checks completed!', 'success');
  });

  safeBind('routing-strategy', 'change', async (e) => {
    const strategy = e.target.value;
    const res = await updateRoutingStrategy(strategy);
    if (res) {
      showToast(`Routing strategy updated to: ${strategy}`, 'success');
    } else {
      showToast('Failed to update routing strategy', 'error');
    }
  });

  safeBind('auto-refresh-interval', 'change', () => {
    setupAutoRefresh();
    const val = document.getElementById('auto-refresh-interval').value;
    showToast(`Auto-refresh set to ${val === '0' ? 'Off' : `${val/1000}s`}`, 'info');
  });

  // Playground removed.

  // --- Guide Tabs & Copy Code Handlers ---
  document.querySelectorAll('.guide-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.guide-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.guide-tab-content').forEach(c => c.classList.add('hidden'));
      
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const contentEl = document.getElementById(targetId);
      if (contentEl) contentEl.classList.remove('hidden');
    });
  });

  document.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;
      
      const text = el.innerText || el.textContent;
      try {
        await navigator.clipboard.writeText(text);
        showToast('📋 Code snippet copied to clipboard!', 'success');
      } catch (err) {
        showToast('❌ Failed to copy code snippet', 'error');
      }
    });
  });

  // --- Clients UI Logic ---
  safeBind('add-client-btn', 'click', async () => {
    const nameInput = document.getElementById('new-client-name');
    const name = nameInput.value.trim();
    if (!name) return showToast('Please enter a client name', 'error');

    const btn = document.getElementById('add-client-btn');
    btn.disabled = true;
    try {
      const res = await apiCall('/api/clients', 'POST', { name });
      if (res && res.success) {
        showToast(`✅ Client "${res.client.name}" created!`, 'success');
        nameInput.value = '';
        await refreshDashboard();
      } else {
        showToast(res && res.error || 'Failed to add client', 'error');
      }
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  window.toggleClient = async (id) => {
    const res = await apiCall(`/api/clients/${id}/toggle`, 'POST');
    if (res && res.success) {
      showToast(`Client ${res.enabled ? 'Enabled' : 'Disabled'}`, 'success');
      refreshDashboard();
    }
  };

  window.deleteClient = async (id) => {
    if (!confirm('Delete this API Key? External apps using this key will be instantly blocked.')) return;
    const res = await apiCall(`/api/clients/${id}`, 'DELETE');
    if (res && res.success) {
      showToast('🗑️ Client deleted', 'success');
      refreshDashboard();
    }
  };

  window.copyClientKey = async (key) => {
    try {
      await navigator.clipboard.writeText(key);
      showToast('✅ Key copied to clipboard!', 'success');
    } catch (err) {
      showToast('❌ Failed to copy', 'error');
    }
  };

  // --- Modal Events ---
  safeBind('add-account-btn', 'click', openAddModal);
  safeBind('modal-close', 'click', closeModal);
  safeBind('modal-cancel', 'click', closeModal);

  safeBind('account-modal', 'click', (e) => {
    if (e.target.id === 'account-modal') closeModal();
  });

  safeBind('account-form', 'submit', async (e) => {
    e.preventDefault();

    const data = {
      id: currentEditId || `ollama-${Date.now()}`,
      type: document.getElementById('form-type').value,
      name: document.getElementById('form-name').value.trim(),
      url: document.getElementById('form-url').value.trim(),
      key: document.getElementById('form-key').value.trim(),
      priority: parseInt(document.getElementById('form-priority').value) || 1,
      enabled: true
    };

    const btn = document.getElementById('modal-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const result = await saveAccount(data);
    btn.disabled = false;
    btn.textContent = 'Save Account';

    if (result && result.success) {
      closeModal();
      showToast(`Account "${data.name}" saved successfully!`, 'success');
      await refreshDashboard();
    } else {
      showToast('❌ Failed to save account', 'error');
    }
  });
}

init();
