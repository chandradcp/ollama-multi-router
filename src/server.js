require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { log, logRequest } = require('./utils');
const {
  loadAccounts,
  getAccounts,
  runHealthChecks,
  toggleAccount,
  updateRoutingStrategy,
  getGlobalRoutingStrategy,
  saveAccount,
  deleteAccount,
  loadUsage,
  flushUsage
} = require('./providers');
const { executeWithFallback, chatCompletion, listModels } = require('./router');
const { sendAllAccountsFailedNotification } = require('./notifications');
const cache = require('./cache');
const stats = require('./stats');
const {
  loadClients,
  getClients,
  addClient,
  toggleClient,
  deleteClient,
  isValidClient,
  getClientName
} = require('./clients');
const {
  openAIRequestToOllama,
  ollamaStreamChunkToOpenAI,
  ollamaResponseToOpenAI,
  ollamaModelsToOpenAI
} = require('./openai-compat');

const app = express();
const PORT = process.env.PORT || 20128;
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware: check local API key (for OpenAI-compatible endpoints)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!isValidClient(token)) {
    return res.status(401).json({
      error: {
        message: 'Invalid or missing client API key',
        type: 'authentication_error'
      }
    });
  }

  next();
}

// Middleware: dashboard basic auth
function dashboardAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const base64 = authHeader.replace('Basic ', '');
  const credentials = Buffer.from(base64, 'base64').toString('utf8');
  const [username, password] = credentials.split(':');

  if (username !== DASHBOARD_USERNAME || password !== DASHBOARD_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).json({ error: { message: 'Unauthorized', type: 'authentication_error' } });
  }

  next();
}

// Static dashboard (protected)
app.use('/dashboard', dashboardAuthMiddleware, express.static(path.join(__dirname, 'dashboard')));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const accounts = getAccounts();
    res.json({
      status: 'ok',
      port: PORT,
      routingStrategy: getGlobalRoutingStrategy(),
      cache: cache.getStats(),
      accounts: accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        enabled: acc.enabled,
        healthy: acc.status?.healthy,
        lastError: acc.status?.lastError,
        requestCount: acc.status?.requestCount,
        errorCount: acc.status?.errorCount,
        rateLimit: acc.status?.rateLimit || null,
        retry: acc.retry || null
      }))
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Dashboard API: get all clients
app.get('/api/clients', dashboardAuthMiddleware, (req, res) => {
  res.json({ success: true, clients: getClients() });
});

// Dashboard API: add a new client
app.post('/api/clients', dashboardAuthMiddleware, (req, res) => {
  try {
    const name = req.body && req.body.name;
    const client = addClient(name);
    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard API: toggle a client
app.post('/api/clients/:id/toggle', dashboardAuthMiddleware, (req, res) => {
  try {
    const result = toggleClient(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard API: delete a client
app.delete('/api/clients/:id', dashboardAuthMiddleware, (req, res) => {
  try {
    const result = deleteClient(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard API: get accounts
app.get('/api/accounts', dashboardAuthMiddleware, (req, res) => {
  res.json(getAccounts());
});

// Dashboard API: toggle account
app.post('/api/accounts/:id/toggle', dashboardAuthMiddleware, (req, res) => {
  const result = toggleAccount(req.params.id);
  if (result.success) {
    res.json({ success: true, enabled: result.enabled });
  } else {
    res.status(404).json(result);
  }
});

// Dashboard API: run health checks
app.post('/api/health-check', dashboardAuthMiddleware, async (req, res) => {
  await runHealthChecks();
  res.json({ success: true, accounts: getAccounts() });
});

// Dashboard API: get current routing strategy
app.get('/api/routing-strategy', dashboardAuthMiddleware, (req, res) => {
  res.json({ strategy: getGlobalRoutingStrategy() });
});

// Dashboard API: update routing strategy
app.post('/api/routing-strategy', dashboardAuthMiddleware, (req, res) => {
  const { strategy } = req.body;
  const result = updateRoutingStrategy(strategy);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// Dashboard API: save account (add or update)
app.post('/api/accounts', dashboardAuthMiddleware, (req, res) => {
  const data = req.body;
  if (!data.id || !data.name || !data.url || !data.key) {
    return res.status(400).json({ success: false, error: 'Missing required fields: id, name, url, key' });
  }
  const result = saveAccount(data);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// Dashboard API: delete account
app.delete('/api/accounts/:id', dashboardAuthMiddleware, (req, res) => {
  const result = deleteAccount(req.params.id);
  if (result.success) {
    res.json(result);
  } else {
    res.status(404).json(result);
  }
});

// Dashboard API: statistics
app.get('/api/stats', dashboardAuthMiddleware, (req, res) => {
  res.json(stats.getAllStats());
});

// Dashboard API: clear statistics
app.post('/api/stats/clear', dashboardAuthMiddleware, (req, res) => {
  stats.clear();
  res.json({ success: true });
});

// Dashboard API: cache stats
app.get('/api/cache', dashboardAuthMiddleware, (req, res) => {
  res.json(cache.getStats());
});

// Dashboard API: clear cache
app.post('/api/cache/clear', dashboardAuthMiddleware, (req, res) => {
  cache.clear();
  res.json({ success: true });
});

// Dashboard API: export config
app.get('/api/config/export', dashboardAuthMiddleware, (req, res) => {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'accounts.json');
    const data = fs.readFileSync(configPath, 'utf8');
    res.setHeader('Content-Disposition', 'attachment; filename="accounts.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard API: import config
app.post('/api/config/import', dashboardAuthMiddleware, (req, res) => {
  try {
    const data = req.body;
    if (!data.accounts || !Array.isArray(data.accounts)) {
      return res.status(400).json({ success: false, error: 'Invalid config: accounts array required' });
    }

    const configPath = path.join(__dirname, '..', 'config', 'accounts.json');
    const configToSave = {
      accounts: data.accounts,
      routingStrategy: data.routingStrategy || 'round-robin'
    };

    fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf8');

    // Reload accounts
    loadAccounts();

    res.json({ success: true, accountCount: data.accounts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// OpenAI-compatible: list models
app.get('/v1/models', authMiddleware, async (req, res) => {
  const start = Date.now();
  try {
    // Check cache
    const cached = cache.get('GET', '/v1/models', {});
    if (cached) {
      logRequest('GET', '/v1/models', 'aggregate', 200, Date.now() - start, { cached: true });
      stats.recordRequest({
        method: 'GET',
        path: '/v1/models',
        accountId: 'aggregate',
        duration: Date.now() - start,
        status: 200,
        success: true,
        cached: true
      });
      return res.json(cached);
    }

    const allModels = [];
    const accounts = getAccounts().filter(acc => acc.enabled);

    for (const account of accounts) {
      try {
        const models = await listModels(account);
        const openAIModels = ollamaModelsToOpenAI(
          models.map(m => m.name || m.model),
          account.id
        );
        allModels.push(...openAIModels);
      } catch (err) {
        log('warn', `Failed to list models from ${account.id}`, err.message);
      }
    }

    const response = { object: 'list', data: allModels };
    cache.set('GET', '/v1/models', {}, response, 60000); // Cache for 1 minute

    logRequest('GET', '/v1/models', 'aggregate', 200, Date.now() - start);
    stats.recordRequest({
      method: 'GET',
      path: '/v1/models',
      accountId: 'aggregate',
      duration: Date.now() - start,
      status: 200,
      success: true
    });

    res.json(response);
  } catch (err) {
    logRequest('GET', '/v1/models', 'aggregate', 500, Date.now() - start);
    stats.recordRequest({
      method: 'GET',
      path: '/v1/models',
      accountId: 'aggregate',
      duration: Date.now() - start,
      status: 500,
      success: false
    });
    res.status(500).json({
      error: { message: err.message, type: 'api_error' }
    });
  }
});

// OpenAI-compatible: chat completions
app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
  const start = Date.now();
  const stream = req.body.stream === true;

  // Only cache non-streaming requests
  let cached = null;
  if (!stream) {
    cached = cache.get('POST', '/v1/chat/completions', req.body);
    if (cached) {
      logRequest('POST', '/v1/chat/completions', 'aggregate', 200, Date.now() - start, { cached: true });
      stats.recordRequest({
        method: 'POST',
        path: '/v1/chat/completions',
        accountId: 'aggregate',
        model: req.body.model,
        duration: Date.now() - start,
        status: 200,
        success: true,
        cached: true,
        tokens: cached.usage || { input: 0, output: 0 }
      });
      return res.json(cached);
    }
  }

  try {
    const ollamaBody = openAIRequestToOllama(req.body, stream);
    const openAIModelName = req.body.model;

    const { result: streamData, account } = await executeWithFallback(
      acc => chatCompletion(acc, ollamaBody, stream),
      parseInt(process.env.MAX_RETRIES || '4', 10)
    );

    logRequest('POST', '/v1/chat/completions', account.id, stream ? 200 : 200, Date.now() - start);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let totalContent = '';
      let sawToolCalls = false;

      streamData.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            const openAIChunk = ollamaStreamChunkToOpenAI(json, openAIModelName);
            const choice = openAIChunk.choices[0];
            totalContent += choice?.delta?.content || '';
            // Ollama may stream tool_calls in a non-final chunk, then a plain
            // done chunk. Remember it so the terminating chunk reports the
            // correct OpenAI finish_reason ('tool_calls' instead of 'stop').
            if (choice?.delta?.tool_calls) sawToolCalls = true;
            if (json.done && sawToolCalls) choice.finish_reason = 'tool_calls';
            res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
          } catch (err) {
            // ignore invalid json
          }
        }
      });

      streamData.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();

        // Record stats for streaming
        stats.recordRequest({
          method: 'POST',
          path: '/v1/chat/completions',
          accountId: account.id,
          model: openAIModelName,
          duration: Date.now() - start,
          status: 200,
          success: true,
          tokens: {
            input: Math.ceil(JSON.stringify(req.body.messages || []).length / 4),
            output: Math.ceil(totalContent.length / 4)
          }
        });
      });

      streamData.on('error', (err) => {
        log('error', 'Stream error', err.message);
        res.end();
      });
    } else {
      const openAIResp = ollamaResponseToOpenAI(streamData, openAIModelName);

      // Cache the response
      cache.set('POST', '/v1/chat/completions', req.body, openAIResp);

      stats.recordRequest({
        method: 'POST',
        path: '/v1/chat/completions',
        accountId: account.id,
        model: openAIModelName,
        duration: Date.now() - start,
        status: 200,
        success: true,
        tokens: openAIResp.usage || { input: 0, output: 0 }
      });

      res.json(openAIResp);
    }
  } catch (err) {
    logRequest('POST', '/v1/chat/completions', 'all-failed', 500, Date.now() - start);

    stats.recordRequest({
      method: 'POST',
      path: '/v1/chat/completions',
      accountId: 'all-failed',
      model: req.body.model,
      duration: Date.now() - start,
      status: 500,
      success: false
    });

    let attempts = [];
    try {
      const match = err.message.match(/Attempts: (.*)/);
      if (match) attempts = JSON.parse(match[1]);
    } catch (e) {}

    await sendAllAccountsFailedNotification(attempts);

    res.status(500).json({
      error: {
        message: err.message,
        type: 'api_error'
      }
    });
  }
});

// OpenAI-compatible: legacy completions (optional)
app.post('/v1/completions', authMiddleware, async (req, res) => {
  const prompt = req.body.prompt || '';
  req.body.messages = [{ role: 'user', content: prompt }];
  req.body.stream = false;

  try {
    const ollamaBody = openAIRequestToOllama(req.body, false);
    const openAIModelName = req.body.model;

    const { result, account } = await executeWithFallback(
      acc => chatCompletion(acc, ollamaBody, false),
      parseInt(process.env.MAX_RETRIES || '4', 10)
    );

    const openAIResp = ollamaResponseToOpenAI(result, openAIModelName);
    const completionText = openAIResp.choices[0]?.message?.content || '';
    res.json({
      id: openAIResp.id,
      object: 'text_completion',
      created: openAIResp.created,
      model: openAIModelName,
      choices: [{
        text: completionText,
        index: 0,
        finish_reason: 'stop'
      }],
      usage: openAIResp.usage
    });
  } catch (err) {
    res.status(500).json({
      error: { message: err.message, type: 'api_error' }
    });
  }
});

// Root redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});

// Persist usage counters on shutdown so "today" survives restarts.
function shutdown(signal) {
  log('info', `Received ${signal}, flushing usage and exiting`);
  try { flushUsage(); } catch (e) { /* best effort */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  loadClients();
  loadAccounts();
  loadUsage();
  await runHealthChecks();

  app.listen(PORT, () => {
    log('info', `Ollama Multi Router running at http://localhost:${PORT}`);
    log('info', `Dashboard: http://localhost:${PORT}/dashboard`);
    log('info', `API endpoint: http://localhost:${PORT}/v1`);

  });
}

start().catch(err => {
  log('error', 'Failed to start server', err.message);
  process.exit(1);
});
