// netlify/functions/submit-performance.js
//
// Receives completed assessment-first scenario attempts from NursingWebApp
// and inserts them into Supabase/PostgREST.
//
// This version is backward-compatible with the older Socratic/concept schema.
// It first tries a rich assessment-first insert. If your existing Supabase
// table does not yet have those newer columns, it automatically falls back to
// the older column shape and stores the full payload in raw/full_record where
// available.
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_TABLE optional, defaults to "performance"

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TABLE = process.env.SUPABASE_TABLE || 'performance';

  console.log('[submit-performance] start', {
    hasUrl: !!SUPABASE_URL,
    hasKey: !!SERVICE_KEY,
    table: TABLE
  });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, {
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.'
    });
  }

  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body.' });
  }

  const normalized = normalizePayload(p);
  const endpoint = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE}`;

  const attempts = [
    { name: 'assessment-first-rich', row: buildRichRow(normalized) },
    { name: 'legacy-with-full-record', row: buildLegacyRow(normalized, true) },
    { name: 'legacy-raw-only', row: buildLegacyRow(normalized, false) }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      console.log('[submit-performance] trying insert shape:', attempt.name);
      const result = await insertRow(endpoint, SERVICE_KEY, attempt.row);
      console.log('[submit-performance] insert OK:', attempt.name);
      return json(200, {
        ok: true,
        insertShape: attempt.name,
        inserted: result
      });
    } catch (error) {
      lastError = error;
      console.warn('[submit-performance] insert failed:', attempt.name, error.message);

      // Only keep retrying when it looks like a schema/column mismatch.
      // For auth/RLS/network problems, stop early because fallback won't help.
      if (!looksLikeColumnMismatch(error)) {
        break;
      }
    }
  }

  return json(500, {
    ok: false,
    error: lastError ? lastError.message : 'Supabase insert failed.'
  });
};

function normalizePayload(p) {
  const evaluation = p.evaluation || {};
  const answers = p.answers || {};

  const submittedAt =
    p.submittedAt ||
    p.completedAt ||
    p.completed_at ||
    new Date().toISOString();

  const scenarioId =
    p.scenarioId ||
    p.questionId ||
    p.question_id ||
    '';

  const scenarioTitle =
    p.title ||
    p.scenarioTitle ||
    p.topic ||
    '';

  const scenarioText =
    p.scenarioText ||
    p.question ||
    '';

  const scorePercent = numberOrNull(
    evaluation.scorePercent ?? p.scorePercent ?? p.score_percent
  );

  const pass = boolOrNull(evaluation.pass ?? p.pass);
  const diagnosisCorrect = boolOrNull(evaluation.diagnosisCorrect ?? p.diagnosisCorrect ?? p.diagnosis_correct);
  const urgencyCorrect = boolOrNull(evaluation.urgencyCorrect ?? p.urgencyCorrect ?? p.urgency_correct);

  const missedAbnormalFindings = arrayOrEmpty(evaluation.missedAbnormalFindings ?? p.missedAbnormalFindings);
  const missedNursingActions = arrayOrEmpty(evaluation.missedNursingActions ?? p.missedNursingActions);
  const missedProviderInterventions = arrayOrEmpty(evaluation.missedProviderInterventions ?? p.missedProviderInterventions);
  const strengths = arrayOrEmpty(evaluation.strengths ?? p.strengths);
  const improvementAreas = arrayOrEmpty(evaluation.improvementAreas ?? p.improvementAreas);
  const competencyBreakdown = arrayOrEmpty(evaluation.competencyBreakdown ?? p.competencyBreakdown);

  const totalItems = competencyBreakdown.reduce((sum, b) => sum + Number(b.total || 0), 0);
  const correctItems = competencyBreakdown.reduce((sum, b) => sum + Number(b.correct || 0), 0);

  const deadline = p.deadline || null;
  const isLate = typeof p.isLate === 'boolean'
    ? p.isLate
    : deadline
      ? new Date(submittedAt).getTime() > new Date(deadline).getTime()
      : false;

  const fullRecord = {
    ...p,
    scenarioId,
    title: scenarioTitle,
    scenarioText,
    answers,
    submittedAt,
    evaluation: {
      ...evaluation,
      scorePercent,
      pass,
      diagnosisCorrect,
      urgencyCorrect,
      missedAbnormalFindings,
      missedNursingActions,
      missedProviderInterventions,
      strengths,
      improvementAreas,
      competencyBreakdown
    }
  };

  return {
    original: p,
    fullRecord,
    evaluation,
    answers,
    submittedAt,
    scenarioId,
    scenarioTitle,
    scenarioText,
    scorePercent,
    pass,
    diagnosisCorrect,
    urgencyCorrect,
    selectedUrgency: evaluation.selectedUrgency || answers.urgency || '',
    tutoringRequired: boolOrNull(evaluation.tutoringRequired ?? !pass),
    missedAbnormalFindings,
    missedNursingActions,
    missedProviderInterventions,
    strengths,
    improvementAreas,
    competencyBreakdown,
    totalItems,
    correctItems,
    isLate
  };
}

function buildRichRow(x) {
  const p = x.original;

  return {
    // Demographics / traceability
    student_name: stringOrNull(p.studentName || p.student?.name),
    student_uuid: stringOrNull(p.studentUUID || p.student?.uuid),
    employee_id: stringOrNull(p.employeeId || p.student?.employeeId),
    email: stringOrNull(p.email || p.googleEmail || p.student?.email),
    google_sub: stringOrNull(p.googleSub),
    google_email: stringOrNull(p.googleEmail || p.email || p.student?.email),
    google_name: stringOrNull(p.googleName || p.studentName || p.student?.name),
    google_hd: stringOrNull(p.googleHd),
    department: stringOrNull(p.department || p.demographics?.department),
    unit: stringOrNull(p.unit || p.demographics?.unit),
    location: stringOrNull(p.location || p.demographics?.location),
    role: stringOrNull(p.role || p.demographics?.role),

    // Course/session/scenario
    course_id: stringOrNull(p.courseId),
    course_name: stringOrNull(p.courseName),
    class_id: stringOrNull(p.classId),
    academic_year: stringOrNull(p.academicYear),
    question_set_id: stringOrNull(p.questionSetId),
    session_id: stringOrNull(p.sessionId),
    scenario_id: stringOrNull(x.scenarioId),
    scenario_title: stringOrNull(x.scenarioTitle),
    scenario_text: stringOrNull(x.scenarioText),

    // Legacy aliases for older dashboards
    question_id: stringOrNull(x.scenarioId),
    week: stringOrNull(p.week),
    week_label: stringOrNull(p.weekLabel),
    question_number: stringOrNull(p.questionNumber),
    topic: stringOrNull(x.scenarioTitle),
    question: stringOrNull(x.scenarioText),

    release_date: stringOrNull(p.releaseDate),
    deadline: stringOrNull(p.deadline),
    started_at: stringOrNull(p.startedAt),
    completed_at: stringOrNull(x.submittedAt),
    submitted_at: stringOrNull(x.submittedAt),
    is_late: !!x.isLate,

    // Assessment-first evaluation
    score_percent: x.scorePercent,
    pass: x.pass,
    diagnosis_correct: x.diagnosisCorrect,
    urgency_correct: x.urgencyCorrect,
    selected_urgency: stringOrNull(x.selectedUrgency),
    tutoring_required: x.tutoringRequired,
    missed_abnormal_findings: x.missedAbnormalFindings,
    missed_nursing_actions: x.missedNursingActions,
    missed_provider_interventions: x.missedProviderInterventions,
    strengths: x.strengths,
    improvement_areas: x.improvementAreas,
    competency_breakdown: x.competencyBreakdown,
    answers: x.answers,
    evaluation: x.fullRecord.evaluation,
    model_used: stringOrNull(p.modelUsed || x.evaluation.modelUsed),

    // Legacy scoring aliases
    total_concepts: x.totalItems || null,
    concepts_mastered: x.correctItems || null,
    total_exchanges: numberOrNull(p.totalExchanges),
    time_minutes: numberOrNull(p.timeMinutes),

    full_record: x.fullRecord,
    raw: x.fullRecord
  };
}

function buildLegacyRow(x, includeFullRecord) {
  const p = x.original;

  const row = {
    student_name: stringOrNull(p.studentName || p.student?.name),
    student_uuid: stringOrNull(p.studentUUID || p.student?.uuid),
    google_sub: stringOrNull(p.googleSub),
    google_email: stringOrNull(p.googleEmail || p.email || p.student?.email),
    google_name: stringOrNull(p.googleName || p.studentName || p.student?.name),
    google_hd: stringOrNull(p.googleHd),

    course_id: stringOrNull(p.courseId),
    course_name: stringOrNull(p.courseName),
    class_id: stringOrNull(p.classId),
    academic_year: stringOrNull(p.academicYear),
    question_set_id: stringOrNull(p.questionSetId),

    question_id: stringOrNull(x.scenarioId),
    week: stringOrNull(p.week),
    week_label: stringOrNull(p.weekLabel),
    question_number: stringOrNull(p.questionNumber),
    topic: stringOrNull(x.scenarioTitle),
    question: stringOrNull(x.scenarioText),

    release_date: stringOrNull(p.releaseDate),
    deadline: stringOrNull(p.deadline),
    started_at: stringOrNull(p.startedAt),
    completed_at: stringOrNull(x.submittedAt),
    is_late: !!x.isLate,

    total_concepts: x.totalItems || null,
    concepts_mastered: x.correctItems || null,
    total_exchanges: numberOrNull(p.totalExchanges),
    time_minutes: numberOrNull(p.timeMinutes),

    self_concepts: p.selfConcepts || null,
    socratic_history: p.socraticHistory || null,
    confirmed_roadmap: p.confirmedRoadmap || null,
    mastered_concepts: p.masteredConcepts || null,
    essay_text: stringOrNull(p.essayText),
    essay_citations: p.essayCitations || null,
    reflection_text: stringOrNull(p.reflectionText),
    reflection_learned: stringOrNull(p.reflectionLearned),

    raw: x.fullRecord
  };

  if (includeFullRecord) {
    row.full_record = x.fullRecord;
  }

  return row;
}

async function insertRow(endpoint, serviceKey, row) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  if (!response.ok) {
    const message = (data && (data.message || data.error || data.details)) || text || 'Supabase insert failed.';
    const error = new Error(String(message));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return Array.isArray(data) ? data[0] : data;
}

function looksLikeColumnMismatch(error) {
  const msg = String(error && error.message || '').toLowerCase();
  const status = Number(error && error.status);

  return (
    status === 400 &&
    (
      msg.includes('column') ||
      msg.includes('schema cache') ||
      msg.includes('could not find') ||
      msg.includes('pgrst204')
    )
  );
}

function stringOrNull(value) {
  return value === '' || value == null ? null : String(value);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value != null ? n : null;
}

function boolOrNull(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function arrayOrEmpty(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return value.split(';').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
