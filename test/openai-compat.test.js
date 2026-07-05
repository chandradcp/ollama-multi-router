const { test } = require('node:test');
const assert = require('node:assert');
const {
  openAIRequestToOllama,
  ollamaStreamChunkToOpenAI,
  ollamaResponseToOpenAI,
  ollamaModelsToOpenAI,
  extractOllamaModel
} = require('../src/openai-compat');

test('extractOllamaModel strips the ollama/ prefix', () => {
  assert.strictEqual(extractOllamaModel('ollama/llama3.2'), 'llama3.2');
  assert.strictEqual(extractOllamaModel('ministral-3:8b'), 'ministral-3:8b');
});

test('openAIRequestToOllama defaults stream to false when the field is absent', () => {
  // Regression: previously defaulted to stream:true, which mismatched the
  // server reading the response as a single JSON object => empty content.
  const body = { model: 'ollama/x', messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual(openAIRequestToOllama(body).stream, false);
});

test('openAIRequestToOllama honours an explicit stream argument from the server', () => {
  const body = { model: 'x', messages: [] };
  assert.strictEqual(openAIRequestToOllama(body, true).stream, true);
  assert.strictEqual(openAIRequestToOllama(body, false).stream, false);
});

test('explicit stream arg overrides body.stream', () => {
  const body = { model: 'x', messages: [], stream: true };
  assert.strictEqual(openAIRequestToOllama(body, false).stream, false);
});

test('openAIRequestToOllama maps model, messages and options', () => {
  const body = {
    model: 'ollama/gemma3:12b',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    top_p: 0.5,
    max_tokens: 128,
    stop: ['END']
  };
  const out = openAIRequestToOllama(body);
  assert.strictEqual(out.model, 'gemma3:12b');
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.options.temperature, 0.2);
  assert.strictEqual(out.options.top_p, 0.5);
  assert.strictEqual(out.options.num_predict, 128);
  assert.deepStrictEqual(out.options.stop, ['END']);
});

test('openAIRequestToOllama applies sane option defaults', () => {
  const out = openAIRequestToOllama({ model: 'x', messages: [] });
  assert.strictEqual(out.options.temperature, 0.7);
  assert.strictEqual(out.options.top_p, 0.9);
});

test('openAIRequestToOllama serializes non-string message content', () => {
  const body = { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const out = openAIRequestToOllama(body);
  assert.strictEqual(typeof out.messages[0].content, 'string');
  assert.match(out.messages[0].content, /hi/);
});

test('ollamaStreamChunkToOpenAI maps delta content and finish_reason', () => {
  const mid = ollamaStreamChunkToOpenAI({ message: { role: 'assistant', content: 'Hel' }, done: false }, 'm');
  assert.strictEqual(mid.object, 'chat.completion.chunk');
  assert.strictEqual(mid.choices[0].delta.content, 'Hel');
  assert.strictEqual(mid.choices[0].finish_reason, null);

  const last = ollamaStreamChunkToOpenAI({ message: { content: '' }, done: true }, 'm');
  assert.strictEqual(last.choices[0].finish_reason, 'stop');
});

test('ollamaResponseToOpenAI maps content and token usage', () => {
  const resp = ollamaResponseToOpenAI({
    message: { role: 'assistant', content: 'hello' },
    prompt_eval_count: 11,
    eval_count: 5
  }, 'gemma3:12b');
  assert.strictEqual(resp.object, 'chat.completion');
  assert.strictEqual(resp.choices[0].message.content, 'hello');
  assert.strictEqual(resp.choices[0].finish_reason, 'stop');
  assert.deepStrictEqual(resp.usage, {
    prompt_tokens: 11,
    completion_tokens: 5,
    total_tokens: 16
  });
});

test('ollamaResponseToOpenAI tolerates missing fields', () => {
  const resp = ollamaResponseToOpenAI({}, 'm');
  assert.strictEqual(resp.choices[0].message.content, '');
  assert.strictEqual(resp.usage.total_tokens, 0);
});

test('ollamaModelsToOpenAI prefixes ids and sets owner', () => {
  const out = ollamaModelsToOpenAI(['gemma3:12b', 'gpt-oss:20b'], 'acct-1');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'ollama/gemma3:12b');
  assert.strictEqual(out[0].object, 'model');
  assert.strictEqual(out[0].owned_by, 'acct-1');
});
