const crypto = require('crypto');
const { log } = require('./utils');

const DEFAULT_CACHE_TTL = parseInt(process.env.CACHE_TTL || '300', 10) * 1000; // 5 minutes
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE || '100', 10);

class ResponseCache {
  constructor() {
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  generateKey(method, path, body) {
    const data = JSON.stringify({ method, path, body });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  get(method, path, body) {
    const key = this.generateKey(method, path, body);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    log('debug', `Cache hit: ${method} ${path}`);
    return entry.data;
  }

  set(method, path, body, data, ttl = DEFAULT_CACHE_TTL) {
    // Don't cache if cache is full
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const key = this.generateKey(method, path, body);
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now()
    });

    log('debug', `Cache set: ${method} ${path}`);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    log('info', 'Cache cleared');
  }

  getStats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(2)
        : 0
    };
  }
}

module.exports = new ResponseCache();
