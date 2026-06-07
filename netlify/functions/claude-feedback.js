// netlify/functions/claude-feedback.js
//
// Tutor backend for NursingWebApp.
// Supports:
//   "anthropic" / "claude"  -> Anthropic Claude
//   "openai" / "gpt"        -> OpenAI Responses API
//   "oss" / "openrouter"    -> OpenRouter or any OpenAI-compatible chat endpoint
//
// Request shape from frontend:
//   { provider, system, messages, max_tokens }
//
// Response shape:
//   { provider, model, text, raw }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const provider = normalizeProvider(
    body.provider || process.env.LLM_PROVIDER || 'anthropic'
  );

  const req = {
    system: body.system || '',
    messages: normalizeMessages(Array.isArray(body.messages) ? body.messages : []),
    maxTokens: Number(body.max_tokens || body.maxTokens || 1000)
  };

  try {
    if (provider === 'openai') {
      return await callOpenAI(req);
    }

    if (provider === 'oss') {
      return await callOpenRouterOrOSS(req);
    }

    return await callAnthropic(req);
  } catch (error) {
    console.error('Tutor backend error:', error);
    return json(500, { error: error.message || 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Provider normalization
// ---------------------------------------------------------------------------
function normalizeProvider(value) {
  const v = String(value || '').trim().toLowerCase();

  if (v === 'claude' || v === 'anthropic') return 'anthropic';
  if (v === 'openai' || v === 'gpt' || v === 'chatgpt') return 'openai';

  if (
    v === 'oss' ||
    v === 'opensource' ||
    v === 'open-source' ||
    v === 'medical' ||
    v === 'openrouter' ||
    v === 'router'
  ) {
    return 'oss';
  }

  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------
async function callAnthropic({ system, messages, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'Missing ANTHROPIC_API_KEY environment variable.' });
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: Number(process.env.AI_TEMPERATURE || 0.25),
      system,
      messages
    })
  });

  const data = await safeJson(response);
  if (!response.ok) return json(response.status, data);

  const text = data.content?.[0]?.text || '';

  return json(200, {
    provider: 'anthropic',
    model,
    text,
    raw: data
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------
async function callOpenAI({ system, messages, maxTokens }) {
  if (!process.env.OPENAI_API_KEY) {
    return json(500, { error: 'Missing OPENAI_API_KEY environment variable.' });
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const input = [];
  if (system) input.push({ role: 'system', content: system });
  for (const m of messages) input.push(m);

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxTokens,
    })
  });

  const data = await safeJson(response);
  if (!response.ok) return json(response.status, data);

  const text = data.output_text || extractOpenAIText(data);

  return json(200, {
    provider: 'openai',
    model,
    text,
    raw: data
  });
}

function extractOpenAIText(data) {
  const parts = [];

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        parts.push(content.text);
      } else if (typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// OpenRouter / OSS OpenAI-compatible chat completions
// ---------------------------------------------------------------------------
async function callOpenRouterOrOSS({ system, messages, maxTokens }) {
  const url =
    process.env.OSS_MEDICAL_API_URL ||
    process.env.OPENROUTER_API_URL ||
    'https://openrouter.ai/api/v1/chat/completions';

  const key =
    process.env.OSS_MEDICAL_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    '';

  const model =
    process.env.OSS_MEDICAL_MODEL ||
    process.env.OPENROUTER_MODEL ||
    'nvidia/nemotron-3-ultra-550b-a55b:free';

  if (!url) {
    return json(500, { error: 'Missing endpoint URL for provider "oss".' });
  }

  if (!model) {
    return json(500, { error: 'Missing model name for provider "oss".' });
  }

  const chatMessages = [];

  if (system) {
    chatMessages.push({
      role: 'system',
      content:
        system +
        '\n\nImportant: Do not reveal your reasoning. Do not explain your internal thinking. Only give the final student-facing tutor response.'
    });
  } else {
    chatMessages.push({
      role: 'system',
      content:
        'You are a nursing education tutor. Ask one Socratic question at a time. Do not reveal your reasoning. Only give the final student-facing tutor response.'
    });
  }

  for (const m of messages) {
    chatMessages.push(m);
  }

  const headers = {
    'content-type': 'application/json'
  };

  if (key) {
    headers['authorization'] = `Bearer ${key}`;
  }

  if (process.env.OSS_MEDICAL_REFERER) {
    headers['HTTP-Referer'] = process.env.OSS_MEDICAL_REFERER;
    headers['X-Title'] = 'Nursing Education Tutor';
  }

  const payload = {
    model,
    max_tokens: maxTokens,
    temperature: Number(process.env.AI_TEMPERATURE || 0.25),
    messages: chatMessages,

    // Critical for Nemotron/OpenRouter reasoning models:
    // hide reasoning from the student-facing output.
    reasoning: {
      effort: 'none',
      exclude: true
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = await safeJson(response);
  if (!response.ok) return json(response.status, data);

  const text =
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    '';

  return json(200, {
    provider: 'oss',
    model,
    text,
    raw: data
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeMessages(messages) {
  const cleaned = [];

  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '').trim();
    if (!content) continue;
    cleaned.push({ role, content });
  }

  return cleaned;
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  };
}