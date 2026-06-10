// netlify/functions/evaluate-scenario.js
//
// AI + rubric evaluator for NursingWebApp.
//
// Purpose:
//   Receives the current scenario, learner answers, and scenario rubric.
//   Returns structured evaluation JSON for the student/faculty dashboards.
//
// Supports providers:
//   "anthropic" / "claude"       -> Claude
//   "openai" / "gpt"             -> OpenAI (GPT) or Azure OpenAI-compatible config
//   "nemotron" / "oss"           -> NVIDIA: Nemotron 3 Ultra via OpenRouter/OpenAI-compatible endpoint
//   "ollama" / "gpt-oss"         -> Ollama GPT-OSS 20B through local Ollama
//
// Request shape from frontend:
//   { provider, scenario, answers, rubric, max_tokens }
//
// Response shape:
//   {
//     provider, providerLabel, model, mode,
//     scorePercent, pass, diagnosisCorrect, urgencyCorrect,
//     selectedUrgency,
//     correctAbnormalFindings, missedAbnormalFindings,
//     correctNursingActions, missedNursingActions,
//     correctProviderInterventions, missedProviderInterventions,
//     strengths, improvementAreas, competencyBreakdown,
//     tutoringRequired, actionsToSupportDevelopment
//   }
//
// Important product rule:
//   The evaluation output should list missed items, but should NOT show a detailed
//   explanation for each missed item. Explanation depth belongs in the post-session
//   tutoring phase handled by claude-feedback.js.

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

  const scenario = body.scenario || {};
  const answers = body.answers || {};
  const rubric = normalizeRubric(body.rubric || scenario.rubric || {});
  const provider = normalizeProvider(body.provider || process.env.EVALUATION_PROVIDER || process.env.LLM_PROVIDER || 'openai');
  const maxTokens = Number(body.max_tokens || body.maxTokens || 1200);

  if (!scenario || !Object.keys(scenario).length) {
    return json(400, { error: 'Missing scenario.' });
  }

  if (!answers || !Object.keys(answers).length) {
    return json(400, { error: 'Missing answers.' });
  }

  try {
    const prompt = buildEvaluationPrompt({ scenario, answers, rubric });
    let aiResult = null;

    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      aiResult = await callAnthropic(prompt, maxTokens);
    } else if (provider === 'openai' && (process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY)) {
      aiResult = await callOpenAIOrAzure(prompt, maxTokens);
    } else if (provider === 'nemotron' && (process.env.NEMOTRON_API_KEY || process.env.OPENROUTER_API_KEY || process.env.NEMOTRON_API_URL || process.env.OPENROUTER_API_URL)) {
      aiResult = await callNemotron(prompt, maxTokens);
    } else if (provider === 'ollama') {
      aiResult = await callOllamaGPTOSS(prompt, maxTokens);
    }

    if (aiResult && aiResult.text) {
      const parsed = parseModelJson(aiResult.text);

      if (parsed) {
        const normalized = finalizeEvaluation(parsed, rubric, {
          provider: aiResult.provider,
          providerLabel: aiResult.providerLabel,
          model: aiResult.model,
          mode: 'ai'
        });

        return json(200, normalized);
      }
    }

    const fallback = evaluateLocally({ scenario, answers, rubric });
    return json(200, finalizeEvaluation(fallback, rubric, providerMeta(provider, 'local-rubric-fallback')));
  } catch (error) {
    console.error('[evaluate-scenario] error:', error);

    const fallback = evaluateLocally({ scenario, answers, rubric });
    return json(200, finalizeEvaluation(fallback, rubric, providerMeta(provider, 'local-rubric-fallback-error')));
  }
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function buildEvaluationPrompt({ scenario, answers, rubric }) {
  const scenarioText = scenario.scenarioText || scenario.question || scenario.text || '';
  const scenarioTitle = scenario.title || scenario.topic || scenario.id || 'Clinical scenario';

  return {
    system:
      'You are a nursing education evaluator. Evaluate an entry-level nurse learner response against the provided clinical scenario and rubric. ' +
      'Return ONLY valid JSON. Do not include markdown. Do not include hidden reasoning. ' +
      'The evaluation may list missed items, but must NOT include detailed explanation for each missed item. ' +
      'Keep explanations for tutoring, not evaluation.',
    user:
      JSON.stringify({
        task: 'Evaluate the learner response against the scenario rubric.',
        scoringRules: [
          'Diagnosis/problem identification must be correct for passing.',
          'Score percentage is based on correctly identified abnormal findings, nursing actions, and anticipated provider interventions from the rubric.',
          'Passing requires correct diagnosis and scorePercent >= passingThreshold.',
          'Recognize clinically equivalent language, abbreviations, and contextually important vitals.',
          'Differentiate normal from abnormal based on the scenario context and trend over time.',
          'Return missed item names only. Do not return per-item clinical explanations.'
        ],
        requiredJsonShape: {
          diagnosisCorrect: 'boolean',
          correctDiagnosisIdentified: 'string',
          urgencyCorrect: 'boolean',
          selectedUrgency: 'string',
          scorePercent: 'number 0-100',
          correctAbnormalFindings: [{ id: 'string', item: 'string', expected: 'string' }],
          missedAbnormalFindings: [{ id: 'string', item: 'string', expected: 'string' }],
          correctNursingActions: [{ id: 'string', item: 'string', expected: 'string' }],
          missedNursingActions: [{ id: 'string', item: 'string', expected: 'string' }],
          correctProviderInterventions: [{ id: 'string', item: 'string', expected: 'string' }],
          missedProviderInterventions: [{ id: 'string', item: 'string', expected: 'string' }],
          strengths: ['string'],
          improvementAreas: ['string'],
          competencyBreakdown: [{ area: 'string', correct: 'number', total: 'number', percent: 'number' }]
        },
        scenario: {
          id: scenario.id || scenario.scenarioId || '',
          title: scenarioTitle,
          text: scenarioText
        },
        learnerAnswers: answers,
        rubric
      })
  };
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------
function normalizeProvider(value) {
  const v = String(value || '').trim().toLowerCase();

  if (v === 'claude' || v === 'anthropic') return 'anthropic';
  if (v === 'openai' || v === 'gpt' || v === 'chatgpt' || v === 'azure' || v === 'azure-openai') return 'openai';

  if (
    v === 'oss' ||
    v === 'opensource' ||
    v === 'open-source' ||
    v === 'openrouter' ||
    v === 'router' ||
    v === 'nemotron' ||
    v === 'nvidia' ||
    v === 'nvidia-nemotron'
  ) {
    return 'nemotron';
  }

  if (v === 'ollama' || v === 'gpt-oss' || v === 'gptoss' || v === 'gpt-oss-20b' || v === 'local') return 'ollama';

  return 'openai';
}

function providerMeta(provider, mode) {
  if (provider === 'anthropic') {
    return {
      provider: 'anthropic',
      providerLabel: 'Claude',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      mode
    };
  }

  if (provider === 'nemotron') {
    return {
      provider: 'nemotron',
      providerLabel: 'NVIDIA: Nemotron 3 Ultra',
      model: process.env.NEMOTRON_MODEL || process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',
      mode
    };
  }

  if (provider === 'ollama') {
    return {
      provider: 'ollama',
      providerLabel: 'Ollama GPT-OSS 20B',
      model: process.env.OLLAMA_MODEL || process.env.GPT_OSS_MODEL || 'gpt-oss:20b',
      mode
    };
  }

  return {
    provider: 'openai',
    providerLabel: 'OpenAI (GPT)',
    model: process.env.AZURE_OPENAI_DEPLOYMENT || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    mode
  };
}

async function callAnthropic(prompt, maxTokens) {
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
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    })
  });

  const data = await safeJson(response);
  if (!response.ok) throw new Error(formatProviderError('Claude', data));

  return {
    provider: 'anthropic',
    providerLabel: 'Claude',
    model,
    text: data.content?.[0]?.text || '',
    raw: data
  };
}

async function callOpenAIOrAzure(prompt, maxTokens) {
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT) {
    return await callAzureOpenAI(prompt, maxTokens);
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      max_output_tokens: maxTokens
    })
  });

  const data = await safeJson(response);
  if (!response.ok) throw new Error(formatProviderError('OpenAI (GPT)', data));

  return {
    provider: 'openai',
    providerLabel: 'OpenAI (GPT)',
    model,
    text: data.output_text || extractOpenAIText(data),
    raw: data
  };
}

async function callAzureOpenAI(prompt, maxTokens) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': process.env.AZURE_OPENAI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      max_tokens: maxTokens
    })
  });

  const data = await safeJson(response);
  if (!response.ok) throw new Error(formatProviderError('Azure OpenAI', data));

  return {
    provider: 'openai',
    providerLabel: 'OpenAI (GPT)',
    model: deployment,
    text: data.choices?.[0]?.message?.content || '',
    raw: data
  };
}

async function callNemotron(prompt, maxTokens) {
  const url = process.env.NEMOTRON_API_URL || process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
  const key = process.env.NEMOTRON_API_KEY || process.env.OPENROUTER_API_KEY || '';
  const model = process.env.NEMOTRON_MODEL || process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

  const headers = { 'content-type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  if (process.env.NEMOTRON_REFERER || process.env.OPENROUTER_REFERER) {
    headers['HTTP-Referer'] = process.env.NEMOTRON_REFERER || process.env.OPENROUTER_REFERER;
    headers['X-Title'] = 'Nursing Education Evaluator';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      reasoning: { effort: 'none', exclude: true }
    })
  });

  const data = await safeJson(response);
  if (!response.ok) throw new Error(formatProviderError('NVIDIA: Nemotron 3 Ultra', data));

  return {
    provider: 'nemotron',
    providerLabel: 'NVIDIA: Nemotron 3 Ultra',
    model,
    text: data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '',
    raw: data
  };
}

async function callOllamaGPTOSS(prompt, maxTokens) {
  const baseUrl = process.env.OLLAMA_BASE_URL || process.env.GPT_OSS_BASE_URL || 'http://127.0.0.1:11434';
  const model = process.env.OLLAMA_MODEL || process.env.GPT_OSS_MODEL || 'gpt-oss:20b';
  const url = baseUrl.endsWith('/api/chat') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      options: {
        temperature: Number(process.env.AI_TEMPERATURE || 0.1),
        num_predict: maxTokens,
        repeat_penalty: Number(process.env.OLLAMA_REPEAT_PENALTY || 1.05)
      }
    })
  });

  const data = await safeJson(response);
  if (!response.ok) throw new Error(formatProviderError('Ollama GPT-OSS 20B', data));

  return {
    provider: 'ollama',
    providerLabel: 'Ollama GPT-OSS 20B',
    model,
    text: data.message?.content || data.response || '',
    raw: data
  };
}

// ---------------------------------------------------------------------------
// Local fallback evaluator
// ---------------------------------------------------------------------------
function evaluateLocally({ answers, rubric }) {
  const allText = Object.values(answers || {}).join(' ').toLowerCase();
  const diagnosisText = String(answers.patientProblem || answers.diagnosis || answers.problem || allText).toLowerCase();

  const diagnosisCorrect = (rubric.acceptedDiagnoses || []).some((term) => phraseHit(diagnosisText, term));
  const findingResults = scoreItemList(rubric.abnormalFindings || [], allText);
  const nursingActionResults = scoreItemList(rubric.nursingActions || [], allText);
  const providerResults = scoreItemList(rubric.providerInterventions || [], allText);
  const urgencyCorrect = scoreUrgency(rubric.urgency, answers);

  const correctClinicalItems =
    findingResults.correct.length +
    nursingActionResults.correct.length +
    providerResults.correct.length;

  const totalClinicalItems =
    (rubric.abnormalFindings || []).length +
    (rubric.nursingActions || []).length +
    (rubric.providerInterventions || []).length;

  const scorePercent = totalClinicalItems ? Math.round((correctClinicalItems / totalClinicalItems) * 100) : 0;

  const strengths = [];
  if (diagnosisCorrect) strengths.push('Correctly identified the likely patient condition.');
  if (findingResults.correct.length) strengths.push(`Recognized ${findingResults.correct.length} abnormal finding(s).`);
  if (nursingActionResults.correct.length) strengths.push(`Identified ${nursingActionResults.correct.length} nursing action(s).`);
  if (providerResults.correct.length) strengths.push(`Anticipated ${providerResults.correct.length} provider intervention(s).`);
  if (urgencyCorrect) strengths.push('Correctly recognized the urgency level.');

  const improvementAreas = [];
  if (!diagnosisCorrect) improvementAreas.push('Diagnosis / problem identification');
  if (findingResults.missed.length) improvementAreas.push('Recognition of abnormal assessment findings');
  if (nursingActionResults.missed.length) improvementAreas.push('Nursing actions and escalation');
  if (providerResults.missed.length) improvementAreas.push('Anticipated provider interventions');
  if (!urgencyCorrect) improvementAreas.push('Urgency classification');

  return {
    diagnosisCorrect,
    correctDiagnosisIdentified: diagnosisCorrect ? 'Detected from learner response' : '',
    urgencyCorrect,
    selectedUrgency: String(answers.urgency || answers.urgency_rationale || '').trim(),
    scorePercent,
    correctAbnormalFindings: findingResults.correct,
    missedAbnormalFindings: findingResults.missed,
    correctNursingActions: nursingActionResults.correct,
    missedNursingActions: nursingActionResults.missed,
    correctProviderInterventions: providerResults.correct,
    missedProviderInterventions: providerResults.missed,
    strengths: strengths.length ? strengths : ['Completed the scenario response for evaluation.'],
    improvementAreas: improvementAreas.length ? improvementAreas : ['Continue strengthening clinical reasoning depth.'],
    competencyBreakdown: buildBreakdown({ findingResults, nursingActionResults, providerResults, diagnosisCorrect, urgencyCorrect, rubric })
  };
}

function scoreItemList(items, text) {
  const correct = [];
  const missed = [];

  for (const item of items) {
    const hit = (item.keywords || item.matchAny || []).some((term) => phraseHit(text, term));
    const compact = compactRubricItem(item);
    if (hit) correct.push(compact);
    else missed.push(compact);
  }

  return { correct, missed };
}

function scoreUrgency(urgencyRubric, answers) {
  const selected = String(answers.urgency || answers.urgency_rationale || answers.urgencyRationale || '').toLowerCase();
  if (!selected) return false;

  const expected = String(urgencyRubric?.expected || '').toLowerCase();
  const keywords = urgencyRubric?.keywords || [];

  if (expected && selected.includes(expected)) return true;
  return keywords.some((kw) => phraseHit(selected, kw));
}

function buildBreakdown({ findingResults, nursingActionResults, providerResults, diagnosisCorrect, urgencyCorrect, rubric }) {
  const rows = [
    {
      area: 'Assessment / Abnormal Findings',
      correct: findingResults.correct.length,
      total: (rubric.abnormalFindings || []).length
    },
    {
      area: 'Nursing Actions',
      correct: nursingActionResults.correct.length,
      total: (rubric.nursingActions || []).length
    }
  ];

  if ((rubric.providerInterventions || []).length) {
    rows.push({
      area: 'Anticipated Provider Interventions',
      correct: providerResults.correct.length,
      total: (rubric.providerInterventions || []).length
    });
  }

  rows.push(
    { area: 'Diagnosis / Problem Identification', correct: diagnosisCorrect ? 1 : 0, total: 1 },
    { area: 'Urgency', correct: urgencyCorrect ? 1 : 0, total: 1 }
  );

  return rows.map((r) => ({ ...r, percent: percent(r.correct, r.total) }));
}

function phraseHit(text, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  if (t === 'mi') return /\bmi\b/i.test(text);
  if (t === 'acs') return /\bacs\b/i.test(text);
  if (t === 'bp') return /\bbp\b|blood pressure/i.test(text);
  if (t === 'hr') return /\bhr\b|heart rate/i.test(text);
  if (t === 'rr') return /\brr\b|respiratory rate|respirations/i.test(text);
  return text.includes(t);
}

// ---------------------------------------------------------------------------
// Normalization and final shape
// ---------------------------------------------------------------------------
function normalizeRubric(input) {
  const rubric = input || {};

  const abnormalFindings = normalizeItemArray(rubric.abnormalFindings || rubric.findings || []);
  const nursingActions = normalizeItemArray(rubric.nursingActions || rubric.requiredNursingActions || rubric.actions || []);
  const providerInterventions = normalizeItemArray(
    rubric.providerInterventions ||
    rubric.anticipatedProviderInterventions ||
    rubric.anticipatedProviderActions ||
    []
  );

  let urgency = rubric.urgency || {};
  if (typeof urgency === 'string') {
    urgency = { expected: urgency, keywords: [urgency] };
  }

  const expectedUrgency = rubric.expectedUrgency || urgency.expected || '';

  return {
    passingThreshold: Number(rubric.passingThreshold || 50),
    acceptedDiagnoses: Array.isArray(rubric.acceptedDiagnoses) ? rubric.acceptedDiagnoses : [],
    abnormalFindings,
    nursingActions,
    providerInterventions,
    urgency: {
      expected: expectedUrgency,
      keywords: Array.isArray(urgency.keywords) ? urgency.keywords : expectedUrgency ? [expectedUrgency] : [],
      why: urgency.why || urgency.whyItMatters || ''
    },
    actionsToSupportDevelopment: rubric.actionsToSupportDevelopment || {}
  };
}

function normalizeItemArray(items) {
  if (!Array.isArray(items)) return [];

  return items.map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: `ITEM${index + 1}`,
        expected: item,
        item,
        keywords: [item]
      };
    }

    const expected = item.expected || item.item || item.label || item.name || '';
    const keywords = item.keywords || item.matchAny || item.terms || (expected ? [expected] : []);

    return {
      id: item.id || `ITEM${index + 1}`,
      expected,
      item: item.item || item.label || expected,
      keywords: Array.isArray(keywords) ? keywords : [String(keywords)],
      why: item.why || item.whyItMatters || ''
    };
  });
}

function finalizeEvaluation(evaluation, rubric, meta) {
  const correctAbnormalFindings = normalizeResultItems(evaluation.correctAbnormalFindings);
  const missedAbnormalFindings = normalizeResultItems(evaluation.missedAbnormalFindings);
  const correctNursingActions = normalizeResultItems(evaluation.correctNursingActions);
  const missedNursingActions = normalizeResultItems(evaluation.missedNursingActions);
  const correctProviderInterventions = normalizeResultItems(evaluation.correctProviderInterventions);
  const missedProviderInterventions = normalizeResultItems(evaluation.missedProviderInterventions);

  const clinicalCorrect = correctAbnormalFindings.length + correctNursingActions.length + correctProviderInterventions.length;
  const clinicalTotal =
    correctAbnormalFindings.length +
    missedAbnormalFindings.length +
    correctNursingActions.length +
    missedNursingActions.length +
    correctProviderInterventions.length +
    missedProviderInterventions.length;

  const scorePercent = Number.isFinite(Number(evaluation.scorePercent))
    ? clamp(Math.round(Number(evaluation.scorePercent)), 0, 100)
    : clinicalTotal
      ? Math.round((clinicalCorrect / clinicalTotal) * 100)
      : 0;

  const diagnosisCorrect = !!evaluation.diagnosisCorrect;
  const pass = diagnosisCorrect && scorePercent >= Number(rubric.passingThreshold || 50);

  const competencyBreakdown = Array.isArray(evaluation.competencyBreakdown) && evaluation.competencyBreakdown.length
    ? evaluation.competencyBreakdown.map((r) => ({
        area: String(r.area || 'Unknown area'),
        correct: Number(r.correct || 0),
        total: Number(r.total || 0),
        percent: Number.isFinite(Number(r.percent)) ? clamp(Math.round(Number(r.percent)), 0, 100) : percent(Number(r.correct || 0), Number(r.total || 0))
      }))
    : buildBreakdown({
        findingResults: { correct: correctAbnormalFindings, missed: missedAbnormalFindings },
        nursingActionResults: { correct: correctNursingActions, missed: missedNursingActions },
        providerResults: { correct: correctProviderInterventions, missed: missedProviderInterventions },
        diagnosisCorrect,
        urgencyCorrect: !!evaluation.urgencyCorrect,
        rubric
      });

  return {
    provider: meta.provider,
    providerLabel: meta.providerLabel,
    model: meta.model,
    mode: meta.mode,
    modelUsed: `${meta.providerLabel} / ${meta.model}`,

    scorePercent,
    pass,
    diagnosisCorrect,
    correctDiagnosisIdentified: String(evaluation.correctDiagnosisIdentified || ''),
    urgencyCorrect: !!evaluation.urgencyCorrect,
    selectedUrgency: String(evaluation.selectedUrgency || ''),

    correctAbnormalFindings,
    missedAbnormalFindings,
    correctNursingActions,
    missedNursingActions,
    correctProviderInterventions,
    missedProviderInterventions,

    strengths: normalizeStringArray(evaluation.strengths, ['Completed the scenario response for evaluation.']),
    improvementAreas: normalizeStringArray(evaluation.improvementAreas, pass ? ['Continue reinforcing clinical reasoning.'] : ['Review missed assessment cues and nursing actions.']),
    competencyBreakdown,
    actionsToSupportDevelopment: rubric.actionsToSupportDevelopment || {},
    tutoringRequired: !pass
  };
}

function normalizeResultItems(items) {
  if (!Array.isArray(items)) return [];

  return items.map((item, index) => {
    if (typeof item === 'string') {
      return { id: `ITEM${index + 1}`, item, expected: item };
    }

    return {
      id: String(item.id || `ITEM${index + 1}`),
      item: String(item.item || item.expected || item.label || item.name || ''),
      expected: String(item.expected || item.item || item.label || item.name || '')
    };
  }).filter((item) => item.item || item.expected);
}

function compactRubricItem(item) {
  return {
    id: String(item.id || ''),
    item: String(item.item || item.expected || ''),
    expected: String(item.expected || item.item || '')
  };
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const arr = value.map((v) => String(v || '').trim()).filter(Boolean);
  return arr.length ? arr : fallback;
}

// ---------------------------------------------------------------------------
// JSON extraction and helpers
// ---------------------------------------------------------------------------
function parseModelJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function extractOpenAIText(data) {
  const parts = [];

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
      else if (typeof content.text === 'string') parts.push(content.text);
    }
  }

  return parts.join('\n').trim();
}

async function safeJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function formatProviderError(label, data) {
  if (!data) return `${label} request failed.`;
  if (typeof data.error === 'string') return `${label}: ${data.error}`;
  if (data.error?.message) return `${label}: ${data.error.message}`;
  if (data.message) return `${label}: ${data.message}`;
  return `${label} request failed.`;
}

function percent(n, d) {
  return d ? Math.round((Number(n || 0) / Number(d || 1)) * 100) : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
