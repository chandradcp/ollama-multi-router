const { test } = require('node:test');
const assert = require('node:assert');

// Mock axios so we can assert exactly which URL/body/headers sendChatRequest
// and listModels build for each account `type`, without hitting the network.
// Node runs each test file in its own process, so this does not leak into
// other suites (same convention as test/router.test.js's providers mock).
const axiosPath = require.resolve('axios');
const calls = { post: [], get: [] };
let mockPostImpl = async (url, body) => ({ data: { url, body } });
let mockGetImpl = async (url) => ({ data: { url } });

require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    post: (...args) => { calls.post.push(args); return mockPostImpl(...args); },
    get: (...args) => { calls.get.push(args); return mockGetImpl(...args); }
  }
};

const { sendChatRequest, listModels } = require('../src/router');

test('sendChatRequest forwards an openai-type account to its own /chat/completions as-is', async () => {
  calls.post.length = 0;
  mockPostImpl = async (url, body) => ({ data: { url, body } });
  const account = { type: 'openai', url: 'https://api.kimi.com/coding/v1', key: 'sk-test' };
  const openAIBody = { model: 'kimi-for-coding', messages: [{ role: 'user', content: 'hi' }] };

  await sendChatRequest(account, openAIBody, false);

  assert.strictEqual(calls.post.length, 1);
  const [url, sentBody, config] = calls.post[0];
  assert.strictEqual(url, 'https://api.kimi.com/coding/v1/chat/completions');
  assert.strictEqual(sentBody.model, 'kimi-for-coding');
  assert.deepStrictEqual(sentBody.messages, openAIBody.messages);
  assert.strictEqual(config.headers.Authorization, 'Bearer sk-test');
});

test('sendChatRequest strips only trailing slashes for an openai-type account (keeps /v1)', async () => {
  calls.post.length = 0;
  mockPostImpl = async (url, body) => ({ data: { url, body } });
  const account = { type: 'openai', url: 'https://api.kimi.com/coding/v1/', key: 'sk-test' };

  await sendChatRequest(account, { model: 'kimi-for-coding', messages: [] }, false);

  assert.strictEqual(calls.post[0][0], 'https://api.kimi.com/coding/v1/chat/completions');
});

test('sendChatRequest translates to Ollama native /api/chat for a default (no type) account', async () => {
  calls.post.length = 0;
  mockPostImpl = async (url, body) => ({ data: { url, body } });
  const account = { url: 'https://ollama.com', key: 'sk-test' }; // no `type` -> defaults to ollama
  const openAIBody = { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] };

  await sendChatRequest(account, openAIBody, false);

  assert.strictEqual(calls.post.length, 1);
  const [url, sentBody] = calls.post[0];
  assert.strictEqual(url, 'https://ollama.com/api/chat');
  assert.strictEqual(sentBody.model, 'llama3.2');
  assert.ok(Array.isArray(sentBody.messages));
});

test('listModels normalizes an OpenAI-shape /models response to {name} objects', async () => {
  calls.get.length = 0;
  mockGetImpl = async () => ({ data: { data: [{ id: 'kimi-for-coding' }, { id: 'k3' }] } });
  const account = { type: 'openai', url: 'https://api.kimi.com/coding/v1', key: 'sk-test' };

  const models = await listModels(account);

  assert.strictEqual(calls.get.length, 1);
  assert.strictEqual(calls.get[0][0], 'https://api.kimi.com/coding/v1/models');
  assert.deepStrictEqual(models, [{ name: 'kimi-for-coding' }, { name: 'k3' }]);
});

test('listModels uses Ollama native /api/tags for a default (no type) account', async () => {
  calls.get.length = 0;
  mockGetImpl = async () => ({ data: { models: [{ name: 'llama3.2' }] } });
  const account = { url: 'https://ollama.com', key: 'sk-test' };

  const models = await listModels(account);

  assert.strictEqual(calls.get[0][0], 'https://ollama.com/api/tags');
  assert.deepStrictEqual(models, [{ name: 'llama3.2' }]);
});
