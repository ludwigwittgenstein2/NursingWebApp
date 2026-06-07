// netlify/functions/claude-feedback.js
//
// Tutor backend. Same request/response shape the frontend already uses
// ({ system, messages, max_tokens } -> { text }), now with THREE providers:
//
//   "anthropic" -> Claude            (api.anthropic.com)
//   "openai"    -> OpenAI            (api.openai.com)
//   "oss"       -> open-source medical LLM via any OpenAI-compatible host
//                  (HuggingFace / OpenRouter / Together / vLLM / Ollama)
//
// Provider is chosen per request via body.provider, falling back to the
// LLM_PROVIDER env var, then to "anthropic".
//
// Env vars:
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-4-6)
//   OPENAI_API_KEY,    OPENAI_MODEL    (default gpt-4o — set to a model you have)
//   OSS_MEDICAL_API_URL  full chat-completions URL, e.g.
//                        https://openrouter.ai/api/v1/chat/completions
//   OSS_MEDICAL_API_KEY  bearer token (omit for a no-auth local server)
//   OSS_MEDICAL_MODEL    e.g. aaditya/Llama3-OpenBioLLM-70B

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const provider = (body.provider || process.env.LLM_PROVIDER || 'anthropic')
    .toString()
    .toLowerCase();

  const req = {
    system: body.system || '',
    messages: Array.isArray(body.messages) ? body.messages : [],
    maxTokens: body.max_tokens || 1000
  };

  try {
    if (provider === 'openai' || provider === 'gpt') {
      return await callChatCompletions({
        label: 'openai',
        url: 'https://api.openai.com/v1/chat/completions',
        key: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        keyName: 'OPENAI_API_KEY',
        req
      });
    }

    if (provider === 'oss' || provider === 'opensource' || provider === 'medical') {
      const extra = {};
      if (process.env.OSS_MEDICAL_REFERER) {
        extra['http-referer'] = process.env.OSS_MEDICAL_REFERER;
        extra['x-title'] = 'Nursing Education Tutor';
      }
      return await callChatCompletions({
        label: 'oss',
        url: process.env.OSS_MEDICAL_API_URL,
        key: process.env.OSS_MEDICAL_API_KEY, // may be empty for local hosts
        model: process.env.OSS_MEDICAL_MODEL,
        keyName: 'OSS_MEDICAL_API_KEY',
        requireKey: false,
        extraHeaders: extra,
        req
      });
    }

    return await callAnthropic(req);
  } catch (error) {
    return json(500, { error: error.message || 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------
async function callAnthropic({ system, messages, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'Missing ANTHROPIC_API_KEY environment variable.' });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages
    })
  });

  const data = await safeJson(response);
  if (!response.ok) return json(response.status, data);

  return json(200, {
    provider: 'anthropic',
    text: data.content?.[0]?.text || '',
    raw: data
  });
}

// ---------------------------------------------------------------------------
// Shared OpenAI-compatible path (used by both OpenAI and the OSS model)
// ---------------------------------------------------------------------------
async function callChatCompletions({ label, url, key, model, keyName, requireKey = true, extraHeaders = {}, req }) {
  if (!url) {
    return json(500, { error: `Missing endpoint URL for provider "${label}".` });
  }
  if (!model) {
    return json(500, { error: `Missing model name for provider "${label}".` });
  }
  if (requireKey && !key) {
    return json(500, { error: `Missing ${keyName} environment variable.` });
  }

  // Claude takes the system prompt as a top-level field; the chat-completions
  // format wants it as the first message instead.
  const chatMessages = [];
  if (req.system) chatMessages.push({ role: 'system', content: req.system });
  for (const m of req.messages) chatMessages.push({ role: m.role, content: m.content });

  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (key) headers['authorization'] = `Bearer ${key}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens,
      temperature: 0.4,
      messages: chatMessages
    })
  });

  const data = await safeJson(response);
  if (!response.ok) return json(response.status, data);

  const text =
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    '';

  return json(200, { provider: label, model, text, raw: data });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function safeJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  };
}