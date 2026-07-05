// Build a lookup from OpenAI tool_call id -> function name using the assistant
// messages, so we can label tool results by name for Ollama (which rejects
// foreign tool_call ids but matches results by tool name).
function buildToolNameMap(messages) {
  const map = {};
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id && tc.function && tc.function.name) {
          map[tc.id] = tc.function.name;
        }
      }
    }
  }
  return map;
}

// Map a single OpenAI-style chat message to Ollama's chat message shape,
// preserving tool-calling fields so agent workflows (e.g. Cursor Agent) work.
function mapMessageToOllama(msg, toolNameMap = {}) {
  const out = { role: msg.role };

  if (msg.content == null) {
    out.content = '';
  } else if (typeof msg.content === 'string') {
    out.content = msg.content;
  } else {
    // OpenAI can send content as an array of parts (text/image). Keep text
    // parts as text; fall back to JSON for anything exotic.
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(p => p && (p.type === 'text' || typeof p.text === 'string'))
        .map(p => p.text)
        .join('');
      out.content = text || JSON.stringify(msg.content);
    } else {
      out.content = JSON.stringify(msg.content);
    }
  }

  if (msg.images) out.images = msg.images;

  // Assistant tool calls: OpenAI sends function.arguments as a JSON *string*,
  // Ollama expects an object.
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    out.tool_calls = msg.tool_calls.map(tc => {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { args = {}; }
      }
      return { function: { name: fn.name, arguments: args || {} } };
    });
  }

  // Tool result messages (role: 'tool'). Ollama matches results by tool name
  // and rejects unknown tool_call ids, so resolve the name and drop the id.
  if (msg.role === 'tool') {
    const name = msg.name || toolNameMap[msg.tool_call_id];
    if (name) out.tool_name = name;
  }

  return out;
}

function openAIMessagesToOllamaPrompt(messages) {
  const toolNameMap = buildToolNameMap(messages);
  return messages.map(msg => mapMessageToOllama(msg, toolNameMap));
}

function extractOllamaModel(modelId) {
  // modelId might be like "ollama/llama3.2" or just "llama3.2"
  if (modelId.startsWith('ollama/')) {
    return modelId.replace('ollama/', '');
  }
  return modelId;
}

// Build Ollama's `options` from OpenAI sampling params, dropping anything unset
// so we don't override Ollama/model defaults with undefined.
function buildOptions(body) {
  const opts = {
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    num_predict: body.max_tokens,
    stop: body.stop,
    seed: body.seed,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty
  };

  // Preserve the previous sensible defaults when the client omits them.
  if (opts.temperature == null) opts.temperature = 0.7;
  if (opts.top_p == null) opts.top_p = 0.9;

  Object.keys(opts).forEach(k => {
    if (opts[k] == null) delete opts[k];
  });

  return opts;
}

function openAIRequestToOllama(body, stream) {
  const model = extractOllamaModel(body.model);
  const messages = openAIMessagesToOllamaPrompt(body.messages || []);

  // The Ollama `stream` flag MUST match how the server reads the response
  // (json vs stream). When omitted, default to non-streaming, which mirrors
  // the OpenAI convention (stream defaults to false).
  const wantStream = stream !== undefined ? stream : body.stream === true;

  const ollama = {
    model,
    messages,
    stream: wantStream,
    options: buildOptions(body)
  };

  // Forward tool definitions so tool-calling models can act as agents.
  if (Array.isArray(body.tools) && body.tools.length) {
    ollama.tools = body.tools;
  }
  // Structured-output request → Ollama's `format: 'json'`.
  if (body.response_format && body.response_format.type === 'json_object') {
    ollama.format = 'json';
  }

  return ollama;
}

// Convert Ollama tool_calls (arguments as object) to OpenAI tool_calls
// (arguments as a JSON string, with an id + type). Returns undefined if none.
function mapOllamaToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc, i) => {
    const fn = tc.function || {};
    let args = fn.arguments;
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args == null ? {} : args); } catch (e) { args = '{}'; }
    }
    return {
      id: tc.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: fn.name, arguments: args }
    };
  });
}

function ollamaStreamChunkToOpenAI(chunk, model) {
  const message = chunk.message || {};
  const toolCalls = mapOllamaToolCalls(message.tool_calls);

  const delta = {
    role: message.role || 'assistant',
    content: message.content || ''
  };
  if (toolCalls) {
    delta.tool_calls = toolCalls.map((tc, i) => ({ index: i, ...tc }));
  }

  let finishReason = null;
  if (chunk.done) finishReason = toolCalls ? 'tool_calls' : 'stop';

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
}

function ollamaResponseToOpenAI(ollamaResp, model) {
  const message = ollamaResp.message || {};
  const toolCalls = mapOllamaToolCalls(message.tool_calls);

  const openAIMessage = {
    role: message.role || 'assistant',
    // OpenAI convention: content is null when the turn is a tool call.
    content: message.content ? message.content : (toolCalls ? null : '')
  };
  if (toolCalls) openAIMessage.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: openAIMessage,
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: ollamaResp.prompt_eval_count || 0,
      completion_tokens: ollamaResp.eval_count || 0,
      total_tokens: (ollamaResp.prompt_eval_count || 0) + (ollamaResp.eval_count || 0)
    }
  };
}

function ollamaModelsToOpenAI(models, accountId) {
  return models.map(name => ({
    id: `ollama/${name}`,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: accountId
  }));
}

module.exports = {
  openAIRequestToOllama,
  ollamaStreamChunkToOpenAI,
  ollamaResponseToOpenAI,
  ollamaModelsToOpenAI,
  extractOllamaModel
};
