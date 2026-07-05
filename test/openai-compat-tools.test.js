const { test } = require('node:test');
const assert = require('node:assert');
const {
  openAIRequestToOllama,
  ollamaResponseToOpenAI,
  ollamaStreamChunkToOpenAI
} = require('../src/openai-compat');

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }
}];

test('request forwards tools when present', () => {
  const out = openAIRequestToOllama({ model: 'x', messages: [], tools: TOOLS });
  assert.deepStrictEqual(out.tools, TOOLS);
});

test('request omits tools when absent/empty', () => {
  assert.strictEqual(openAIRequestToOllama({ model: 'x', messages: [] }).tools, undefined);
  assert.strictEqual(openAIRequestToOllama({ model: 'x', messages: [], tools: [] }).tools, undefined);
});

test('request forwards extra sampling params and drops unset ones', () => {
  const out = openAIRequestToOllama({
    model: 'x', messages: [],
    seed: 42, frequency_penalty: 0.5, presence_penalty: 0.2, top_k: 40, max_tokens: 256
  });
  assert.strictEqual(out.options.seed, 42);
  assert.strictEqual(out.options.frequency_penalty, 0.5);
  assert.strictEqual(out.options.presence_penalty, 0.2);
  assert.strictEqual(out.options.top_k, 40);
  assert.strictEqual(out.options.num_predict, 256);
  // unset ones are not present at all
  assert.ok(!('stop' in out.options));
});

test('request maps response_format json_object to Ollama format', () => {
  const out = openAIRequestToOllama({ model: 'x', messages: [], response_format: { type: 'json_object' } });
  assert.strictEqual(out.format, 'json');
});

test('assistant tool_calls: OpenAI string arguments become an object for Ollama', () => {
  const out = openAIRequestToOllama({
    model: 'x',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } }]
    }]
  });
  const tc = out.messages[0].tool_calls[0];
  assert.strictEqual(tc.function.name, 'get_weather');
  assert.deepStrictEqual(tc.function.arguments, { city: 'Jakarta' });
  assert.strictEqual(out.messages[0].content, '');
});

test('tool result message: tool_call_id is dropped (Ollama rejects foreign ids)', () => {
  const out = openAIRequestToOllama({
    model: 'x',
    messages: [{ role: 'tool', name: 'get_weather', tool_call_id: 'c1', content: '{"temp":30}' }]
  });
  const m = out.messages[0];
  assert.strictEqual(m.role, 'tool');
  assert.strictEqual(m.tool_name, 'get_weather');
  assert.ok(!('tool_call_id' in m), 'tool_call_id must not be forwarded to Ollama');
  assert.strictEqual(m.content, '{"temp":30}');
});

test('tool result without name resolves tool_name from the assistant tool_call id', () => {
  const out = openAIRequestToOllama({
    model: 'x',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":30}' } // no `name`, like OpenAI clients send
    ]
  });
  const toolMsg = out.messages[1];
  assert.strictEqual(toolMsg.tool_name, 'get_weather');
  assert.ok(!('tool_call_id' in toolMsg));
});

test('multimodal content array collapses to its text', () => {
  const out = openAIRequestToOllama({
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] }]
  });
  assert.strictEqual(out.messages[0].content, 'hello world');
});

test('non-stream response maps Ollama tool_calls to OpenAI shape', () => {
  const resp = ollamaResponseToOpenAI({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Jakarta' } } }]
    },
    prompt_eval_count: 5,
    eval_count: 3
  }, 'm');

  const choice = resp.choices[0];
  assert.strictEqual(choice.finish_reason, 'tool_calls');
  assert.strictEqual(choice.message.content, null);
  const tc = choice.message.tool_calls[0];
  assert.strictEqual(tc.type, 'function');
  assert.ok(tc.id);
  assert.strictEqual(tc.function.name, 'get_weather');
  // arguments must be a JSON *string* for OpenAI clients
  assert.strictEqual(typeof tc.function.arguments, 'string');
  assert.deepStrictEqual(JSON.parse(tc.function.arguments), { city: 'Jakarta' });
});

test('non-stream plain response is unchanged (finish_reason stop, content string)', () => {
  const resp = ollamaResponseToOpenAI({ message: { role: 'assistant', content: 'hi' } }, 'm');
  assert.strictEqual(resp.choices[0].finish_reason, 'stop');
  assert.strictEqual(resp.choices[0].message.content, 'hi');
  assert.ok(!resp.choices[0].message.tool_calls);
});

test('stream chunk maps tool_calls with an index and tool_calls finish reason', () => {
  const chunk = ollamaStreamChunkToOpenAI({
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Jakarta' } } }] },
    done: true
  }, 'm');
  const d = chunk.choices[0].delta;
  assert.strictEqual(chunk.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(d.tool_calls[0].index, 0);
  assert.strictEqual(d.tool_calls[0].function.name, 'get_weather');
  assert.strictEqual(typeof d.tool_calls[0].function.arguments, 'string');
});
