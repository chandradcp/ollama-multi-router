const { log } = require('./utils');

class StatsTracker {
  constructor() {
    this.requests = [];
    this.maxRequests = 10000;
    this.accountStats = new Map();
    this.modelStats = new Map();
    this.hourlyStats = new Map();
  }

  recordRequest(data) {
    const record = {
      timestamp: Date.now(),
      method: data.method,
      path: data.path,
      accountId: data.accountId,
      model: data.model,
      duration: data.duration,
      status: data.status,
      success: data.success,
      tokens: data.tokens || { input: 0, output: 0 },
      cached: data.cached || false
    };

    this.requests.push(record);

    // Trim old requests
    if (this.requests.length > this.maxRequests) {
      this.requests.shift();
    }

    // Update account stats
    this.updateAccountStats(record);

    // Update model stats
    this.updateModelStats(record);

    // Update hourly stats
    this.updateHourlyStats(record);
  }

  updateAccountStats(record) {
    if (!record.accountId) return;

    const stats = this.accountStats.get(record.accountId) || {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalDuration: 0,
      avgDuration: 0,
      totalTokens: 0,
      cachedRequests: 0
    };

    stats.totalRequests++;
    if (record.success) {
      stats.successfulRequests++;
    } else {
      stats.failedRequests++;
    }
    stats.totalDuration += record.duration || 0;
    stats.avgDuration = stats.totalDuration / stats.totalRequests;
    stats.totalTokens += (record.tokens?.input || 0) + (record.tokens?.output || 0);
    if (record.cached) stats.cachedRequests++;

    this.accountStats.set(record.accountId, stats);
  }

  updateModelStats(record) {
    if (!record.model) return;

    const stats = this.modelStats.get(record.model) || {
      totalRequests: 0,
      totalTokens: 0
    };

    stats.totalRequests++;
    stats.totalTokens += (record.tokens?.input || 0) + (record.tokens?.output || 0);
    this.modelStats.set(record.model, stats);
  }

  updateHourlyStats(record) {
    const hour = new Date(record.timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const stats = this.hourlyStats.get(hour) || {
      requests: 0,
      successful: 0,
      failed: 0,
      tokens: 0
    };

    stats.requests++;
    if (record.success) stats.successful++;
    else stats.failed++;
    stats.tokens += (record.tokens?.input || 0) + (record.tokens?.output || 0);
    this.hourlyStats.set(hour, stats);
  }

  getAccountStats(accountId) {
    return this.accountStats.get(accountId) || {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalDuration: 0,
      avgDuration: 0,
      totalTokens: 0,
      cachedRequests: 0
    };
  }

  getAllStats() {
    const recentRequests = this.requests.slice(-100);
    const totalRequests = this.requests.length;
    const successfulRequests = this.requests.filter(r => r.success).length;
    const failedRequests = totalRequests - successfulRequests;
    const avgDuration = totalRequests > 0
      ? this.requests.reduce((sum, r) => sum + (r.duration || 0), 0) / totalRequests
      : 0;
    const totalTokens = this.requests.reduce((sum, r) =>
      sum + (r.tokens?.input || 0) + (r.tokens?.output || 0), 0);
    const cachedRequests = this.requests.filter(r => r.cached).length;

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      successRate: totalRequests > 0 ? ((successfulRequests / totalRequests) * 100).toFixed(2) : 0,
      avgDuration: Math.round(avgDuration),
      totalTokens,
      cachedRequests,
      recentRequests,
      accountStats: Object.fromEntries(this.accountStats),
      modelStats: Object.fromEntries(this.modelStats),
      hourlyStats: Object.fromEntries(this.hourlyStats)
    };
  }

  clear() {
    this.requests = [];
    this.accountStats.clear();
    this.modelStats.clear();
    this.hourlyStats.clear();
    log('info', 'Statistics cleared');
  }
}

module.exports = new StatsTracker();
