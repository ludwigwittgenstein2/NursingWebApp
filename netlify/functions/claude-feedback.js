// netlify/functions/claude-feedback.js
//
// Tutor backend for NursingWebApp.
//
// This function is for POST-SESSION TUTORING ONLY.
// Scenario scoring/evaluation should live in:
//   netlify/functions/evaluate-scenario.js
//
// Supports these provider values from index.html/admin.html:
//   "anthropic" / "claude"       -> Claude
//   "openai" / "gpt"             -> OpenAI (GPT)
//   "nemotron" / "nvidia" / "oss"-> NVIDIA: Nemotron 3 Ultra via OpenRouter/OpenAI-compatible endpoint
//   "ollama" / "gpt-oss"         -> Ollama GPT-OSS 20B through local Ollama
//
// Request shape from frontend:
//   {
//     provider: "anthropic" | "openai" | "nemotron" | "ollama",
//     system: "...",
//     messages: [{ role: "user" | "assistant", content: "..." }],
//     max_tokens: 900
//   }
//
// Response shape:
//   {
//     ok: true,
//     provider,
//     providerLabel,
//     model,
//     text,
//     raw
//   }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, {
      ok: false,
      error: 'Method Not Allowed'
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, {
      ok: false,
      error: 'Invalid JSON body'
    });
  }

  const provider = normalizeProvider(
    body.provider || process.env.LLM_PROVIDER || 'anthropic'
  );

  const req = {
    system: String(body.system || '').trim(),
    messages: normalizeMessages(Array.isArray(body.messages) ? body.messages : []),
    maxTokens: clampNumber(body.max_tokens || body.maxTokens || 900, 1, 2000)
  };

  if (!req.messages.length) {
    return json(400, {
      ok: false,
      provider,
      providerLabel: providerLabel(provider),
      error: 'No messages were provided.'
    });
  }

  try {
    if (provider === 'openai') {
      return await callOpenAI(req);
    }

    if (provider === 'nemotron') {
      return await callNemotron(req);
    }

    if (provider === 'ollama') {
      return await callOllamaGPTOSS(req);
    }

    return await callAnthropic(req);
  } catch (error) {
    console.error('Tutor backend error:', error);

    return json(500, {
      ok: false,
      provider,
      providerLabel: providerLabel(provider),
      error: error.message || 'Server error'
    });
  }
};

// ---------------------------------------------------------------------------
// Provider normalization
// ---------------------------------------------------------------------------
function normalizeProvider(value) {
  const v = String(value || '').trim().toLowerCase();

  if (v === 'claude' || v === 'anthropic') {
    return 'anthropic';
  }

  if (
    v === 'openai' ||
    v === 'gpt' ||
    v === 'chatgpt'
  ) {
    return 'openai';
  }

  if (
    v === 'nemotron' ||
    v === 'nvidia' ||
    v === 'nvidia-nemotron' ||
    v === 'oss' ||
    v === 'opensource' ||
    v === 'open-source' ||
    v === 'openrouter' ||
    v === 'router'
  ) {
    return 'nemotron';
  }

  if (
    v === 'ollama' ||
    v === 'gpt-oss' ||
    v === 'gptoss' ||
    v === 'gpt-oss-20b' ||
    v === 'local'
  ) {
    return 'ollama';
  }

  return 'anthropic';
}

function providerLabel(provider) {
  return {
    anthropic: 'Claude',
    openai: 'OpenAI (GPT)',
    nemotron: 'NVIDIA: Nemotron 3 Ultra',
    ollama: 'Ollama GPT-OSS 20B'
  }[provider] || 'Claude';
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
async function callAnthropic({ system, messages, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, {
      ok: false,
      provider: 'anthropic',
      providerLabel: 'Claude',
      error: 'Missing ANTHROPIC_API_KEY environment variable.'
    });
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
      system: buildTutorSystem(system),
      messages
    })
  });

  const data = await safeJson(response);

  if (!response.ok) {
    return json(response.status, {
      ok: false,
      provider: 'anthropic',
      providerLabel: 'Claude',
      model,
      error: data.error || data
    });
  }

  const text = data.content?.[0]?.text || '';

  return json(200, {
    ok: true,
    provider: 'anthropic',
    providerLabel: 'Claude',
    model,
    text,
    raw: data
  });
}

// ---------------------------------------------------------------------------
// OpenAI (GPT)
// ---------------------------------------------------------------------------
async function callOpenAI({ system, messages, maxTokens }) {
  if (!process.env.OPENAI_API_KEY) {
    return json(500, {
      ok: false,
      provider: 'openai',
      providerLabel: 'OpenAI (GPT)',
      error: 'Missing OPENAI_API_KEY environment variable.'
    });
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const input = [
    {
      role: 'system',
      content: buildTutorSystem(system)
    },
    ...messages
  ];

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxTokens
    })
  });

  const data = await safeJson(response);

  if (!response.ok) {
    return json(response.status, {
      ok: false,
      provider: 'openai',
      providerLabel: 'OpenAI (GPT)',
      model,
      error: data.error || data
    });
  }

  const text = data.output_text || extractOpenAIText(data);

  return json(200, {
    ok: true,
    provider: 'openai',
    providerLabel: 'OpenAI (GPT)',
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
// NVIDIA: Nemotron 3 Ultra
// Usually through OpenRouter or another OpenAI-compatible chat endpoint.
// ---------------------------------------------------------------------------
async function callNemotron({ system, messages, maxTokens }) {
  const url =
    process.env.NEMOTRON_API_URL ||
    process.env.OPENROUTER_API_URL ||
    'https://openrouter.ai/api/v1/chat/completions';

  const key =
    process.env.NEMOTRON_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    '';

  const model =
    process.env.NEMOTRON_MODEL ||
    process.env.OPENROUTER_MODEL ||
    'nvidia/nemotron-3-ultra-550b-a55b:free';

  if (!url) {
    return json(500, {
      ok: false,
      provider: 'nemotron',
      providerLabel: 'NVIDIA: Nemotron 3 Ultra',
      error: 'Missing endpoint URL for NVIDIA: Nemotron 3 Ultra.'
    });
  }

  if (!model) {
    return json(500, {
      ok: false,
      provider: 'nemotron',
      providerLabel: 'NVIDIA: Nemotron 3 Ultra',
      error: 'Missing model name for NVIDIA: Nemotron 3 Ultra.'
    });
  }

  const headers = {
    'content-type': 'application/json'
  };

  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  if (process.env.NEMOTRON_REFERER || process.env.OPENROUTER_REFERER) {
    headers['HTTP-Referer'] =
      process.env.NEMOTRON_REFERER || process.env.OPENROUTER_REFERER;
    headers['X-Title'] = 'Nursing Education Tutor';
  }

  const payload = {
    model,
    max_tokens: maxTokens,
    temperature: Number(process.env.AI_TEMPERATURE || 0.25),
    messages: [
      {
        role: 'system',
        content: buildTutorSystem(system)
      },
      ...messages
    ],

    // For reasoning-capable models: keep hidden reasoning out of student-facing output.
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

  if (!response.ok) {
    return json(response.status, {
      ok: false,
      provider: 'nemotron',
      providerLabel: 'NVIDIA: Nemotron 3 Ultra',
      model,
      error: data.error || data
    });
  }

  const text =
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    '';

  return json(200, {
    ok: true,
    provider: 'nemotron',
    providerLabel: 'NVIDIA: Nemotron 3 Ultra',
    model,
    text,
    raw: data
  });
}

// ---------------------------------------------------------------------------
// Ollama GPT-OSS 20B
//
// Local development:
//   1. Run: ollama serve
//   2. Make sure model exists: ollama list
//   3. Use: gpt-oss:20b
//
// Default local endpoint:
//   http://127.0.0.1:11434/api/chat
//
// This works with netlify dev on your machine.
// A deployed Netlify site cannot reach your laptop's localhost.
// ---------------------------------------------------------------------------
async function callOllamaGPTOSS({ system, messages, maxTokens }) {
  const baseUrl =
    process.env.OLLAMA_BASE_URL ||
    process.env.GPT_OSS_BASE_URL ||
    'http://127.0.0.1:11434';

  const model =
    process.env.OLLAMA_MODEL ||
    process.env.GPT_OSS_MODEL ||
    'gpt-oss:20b';

  const url = baseUrl.endsWith('/api/chat')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: buildTutorSystem(system)
        },
        ...messages
      ],
      options: {
        temperature: Number(process.env.AI_TEMPERATURE || 0.25),
        num_predict: maxTokens,
        repeat_penalty: Number(process.env.OLLAMA_REPEAT_PENALTY || 1.05)
      }
    })
  });

  const data = await safeJson(response);

  if (!response.ok) {
    return json(response.status, {
      ok: false,
      provider: 'ollama',
      providerLabel: 'Ollama GPT-OSS 20B',
      model,
      error: data.error || data
    });
  }

  const text =
    data.message?.content ||
    data.response ||
    '';

  return json(200, {
    ok: true,
    provider: 'ollama',
    providerLabel: 'Ollama GPT-OSS 20B',
    model,
    text,
    raw: data
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildTutorSystem(system) {
  const base = system || 'You are a nursing education tutor.';

  return (
    base +
    '\n\nTutor behavior requirements:' +
    '\n- This is post-assessment tutoring, not the initial evaluation.' +
    '\n- Reference only the weak or failed scenarios provided by the app.' +
    '\n- Separate strengths from improvement areas.' +
    '\n- Explain why missed findings or missed nursing actions matter clinically.' +
    '\n- Use scenario-specific language.' +
    '\n- Ask one focused follow-up question at a time.' +
    '\n- Do not re-score the learner unless explicitly asked.' +
    '\n- Do not reveal private reasoning, hidden chain-of-thought, or internal deliberation.' +
    '\n- Provide only the final student-facing tutor response.'
  );
}

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

function clampNumber(value, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(n)));
}

async function safeJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json'
    },
    body: JSON.stringify(obj)
  };
}
