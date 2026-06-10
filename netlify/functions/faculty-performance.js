// netlify/functions/faculty-performance.js
//
// Faculty dashboard backend for NursingWebApp.
// Reads assessment-first records from Supabase/PostgREST and maps them into
// the shape expected by faculty.html.
//
// Supports BOTH:
//   1. New assessment-first records: sessions, scenarios, score %, missed findings/actions
//   2. Older Socratic/concept records: completedExercises-style fields
//
// Env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   FACULTY_DASHBOARD_PASSWORD
//   SUPABASE_TABLE optional, defaults to "performance"

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method Not Allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const DASHBOARD_PASSWORD = process.env.FACULTY_DASHBOARD_PASSWORD;
  const PERFORMANCE_TABLE = process.env.SUPABASE_TABLE || 'performance';

  if (!SUPABASE_URL || !SERVICE_KEY || !DASHBOARD_PASSWORD) {
    return jsonResponse(500, {
      ok: false,
      error: 'Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or FACULTY_DASHBOARD_PASSWORD environment variable.'
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON body.' });
  }

  if (body.password !== DASHBOARD_PASSWORD) {
    return jsonResponse(401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const [performanceRows, studentRows, paRows] = await Promise.all([
      fetchTable(SUPABASE_URL, SERVICE_KEY, PERFORMANCE_TABLE, 'completed_at.desc.nullslast'),
      fetchTableOptional(SUPABASE_URL, SERVICE_KEY, 'students'),
      fetchTableOptional(SUPABASE_URL, SERVICE_KEY, 'pas')
    ]);

    return jsonResponse(200, {
      ok: true,
      performance: { rows: performanceRows.map(mapPerformanceRow) },
      students: { rows: studentRows.map(mapStudentRow) },
      pas: { rows: paRows.map(mapPaRow) }
    });
  } catch (error) {
    console.error('[faculty-performance] error', error);
    return jsonResponse(500, { ok: false, error: error.message || 'Server error' });
  }
};

async function fetchTable(baseUrl, serviceKey, tableName, order) {
  const root = baseUrl.replace(/\/$/, '');
  const url = new URL(`${root}/rest/v1/${tableName}`);
  url.searchParams.set('select', '*');
  if (order) url.searchParams.set('order', order);

  let response = await fetch(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders(serviceKey)
  });

  // If ordering fails because a legacy table lacks completed_at, retry without order.
  if (!response.ok && order) {
    const firstText = await response.text();
    console.warn('[faculty-performance] ordered fetch failed; retrying without order', response.status, firstText.slice(0, 300));

    const retry = new URL(`${root}/rest/v1/${tableName}`);
    retry.searchParams.set('select', '*');
    response = await fetch(retry.toString(), {
      method: 'GET',
      headers: supabaseHeaders(serviceKey)
    });
  }

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  if (!response.ok) {
    throw new Error((data && (data.message || data.error)) || `Could not read ${tableName}.`);
  }

  return Array.isArray(data) ? data : [];
}

async function fetchTableOptional(baseUrl, serviceKey, tableName) {
  try {
    return await fetchTable(baseUrl, serviceKey, tableName);
  } catch (error) {
    console.warn(`[faculty-performance] optional table ${tableName} unavailable:`, error.message);
    return [];
  }
}

function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    accept: 'application/json'
  };
}

function mapPerformanceRow(r) {
  const full = parseJsonLike(r.full_record) || parseJsonLike(r.raw) || {};
  const evaluation = parseJsonLike(r.evaluation) || full.evaluation || {};
  const answers = parseJsonLike(r.answers) || full.answers || {};

  const scenarioId =
    r.scenario_id ||
    r.question_id ||
    full.scenarioId ||
    full.questionId ||
    '';

  const scenarioTitle =
    r.scenario_title ||
    r.topic ||
    full.title ||
    full.topic ||
    '';

  const scorePercent = firstDefined(
    r.score_percent,
    r.scorePercent,
    evaluation.scorePercent,
    full.scorePercent,
    ''
  );

  const pass = firstDefined(
    r.pass,
    evaluation.pass,
    full.pass,
    ''
  );

  const diagnosisCorrect = firstDefined(
    r.diagnosis_correct,
    r.diagnosisCorrect,
    evaluation.diagnosisCorrect,
    full.diagnosisCorrect,
    ''
  );

  const completedAt =
    r.completed_at ||
    r.completedAt ||
    r.submitted_at ||
    r.created_at ||
    full.submittedAt ||
    full.completedAt ||
    '';

  const sessionId =
    r.session_id ||
    full.sessionId ||
    '';

  const studentName =
    r.student_name ||
    full.studentName ||
    full.student?.name ||
    full.student?.studentName ||
    full.googleName ||
    '';

  const email =
    r.email ||
    r.google_email ||
    full.email ||
    full.googleEmail ||
    full.student?.email ||
    '';

  const employeeId =
    r.employee_id ||
    full.employeeId ||
    full.student?.employeeId ||
    '';

  const missedAbnormalFindings = normalizeArray(
    r.missed_abnormal_findings,
    evaluation.missedAbnormalFindings,
    full.missedAbnormalFindings
  );

  const missedNursingActions = normalizeArray(
    r.missed_nursing_actions,
    evaluation.missedNursingActions,
    full.missedNursingActions
  );

  const missedProviderInterventions = normalizeArray(
    r.missed_provider_interventions,
    evaluation.missedProviderInterventions,
    full.missedProviderInterventions
  );

  const strengths = normalizeArray(r.strengths, evaluation.strengths, full.strengths);
  const improvementAreas = normalizeArray(r.improvement_areas, evaluation.improvementAreas, full.improvementAreas);
  const competencyBreakdown = normalizeArray(r.competency_breakdown, evaluation.competencyBreakdown, full.competencyBreakdown);

  const reconstructed = {
    ...full,
    sessionId,
    scenarioId,
    title: scenarioTitle,
    answers,
    evaluation: {
      ...evaluation,
      scorePercent: numericOrBlank(scorePercent),
      pass: booleanOrBlank(pass),
      diagnosisCorrect: booleanOrBlank(diagnosisCorrect),
      urgencyCorrect: firstDefined(r.urgency_correct, evaluation.urgencyCorrect, ''),
      selectedUrgency: firstDefined(r.selected_urgency, evaluation.selectedUrgency, ''),
      tutoringRequired: firstDefined(r.tutoring_required, evaluation.tutoringRequired, ''),
      missedAbnormalFindings,
      missedNursingActions,
      missedProviderInterventions,
      strengths,
      improvementAreas,
      competencyBreakdown
    }
  };

  return {
    // New assessment-first fields
    submittedAt: r.created_at || completedAt || '',
    completedAt,
    sessionId,
    scenarioId,
    scenarioTitle,
    scorePercent,
    pass,
    diagnosisCorrect,
    urgencyCorrect: firstDefined(r.urgency_correct, evaluation.urgencyCorrect, ''),
    selectedUrgency: firstDefined(r.selected_urgency, evaluation.selectedUrgency, ''),
    tutoringRequired: firstDefined(r.tutoring_required, evaluation.tutoringRequired, ''),
    missedAbnormalFindings,
    missedNursingActions,
    missedProviderInterventions,
    strengths,
    improvementAreas,
    competencyBreakdown,
    answers,
    modelUsed: r.model_used || evaluation.modelUsed || full.modelUsed || '',

    // Demographics
    studentName,
    employeeId,
    email,
    studentUUID: r.student_uuid || full.studentUUID || full.student?.uuid || '',
    googleSub: r.google_sub || full.googleSub || '',
    googleEmail: email,
    googleName: r.google_name || full.googleName || studentName,
    googleHd: r.google_hd || full.googleHd || '',
    department: r.department || full.department || full.demographics?.department || '',
    unit: r.unit || full.unit || full.demographics?.unit || '',
    location: r.location || full.location || full.demographics?.location || '',
    role: r.role || full.role || full.demographics?.role || '',

    // Legacy fields retained for older faculty.html logic
    classId: r.class_id || full.classId || '',
    academicYear: r.academic_year || full.academicYear || '',
    questionSetId: r.question_set_id || full.questionSetId || '',
    courseId: r.course_id || full.courseId || '',
    courseName: r.course_name || full.courseName || '',
    questionId: scenarioId,
    week: r.week || full.week || '',
    weekLabel: r.week_label || full.weekLabel || '',
    questionNumber: r.question_number || full.questionNumber || '',
    topic: scenarioTitle,
    releaseDate: r.release_date || full.releaseDate || '',
    deadline: r.deadline || full.deadline || '',
    startedAt: r.started_at || full.startedAt || '',
    isLate: String(firstDefined(r.is_late, full.isLate, false)),
    totalConcepts: firstDefined(r.total_concepts, full.totalConcepts, ''),
    conceptsMastered: firstDefined(r.concepts_mastered, full.conceptsMastered, ''),
    totalExchanges: firstDefined(r.total_exchanges, full.totalExchanges, ''),
    timeMinutes: firstDefined(r.time_minutes, full.timeMinutes, ''),
    fullRecordJson: JSON.stringify(reconstructed)
  };
}

function mapStudentRow(s) {
  return {
    googleEmail: s.google_email || s.email || '',
    studentName: s.student_name || s.name || '',
    studentUUID: s.student_uuid || '',
    employeeId: s.employee_id || '',
    classId: s.class_id || '',
    courseId: s.course_id || '',
    department: s.department || '',
    unit: s.unit || '',
    location: s.location || '',
    role: s.role || '',
    assignedPAEmail: s.assigned_pa_email || '',
    active: String(s.active ?? '')
  };
}

function mapPaRow(p) {
  return {
    paEmail: p.pa_email || p.email || '',
    paName: p.pa_name || p.name || '',
    active: String(p.active ?? '')
  };
}

function parseJsonLike(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeArray(...values) {
  for (const value of values) {
    const parsed = parseJsonLike(value) || value;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string' && parsed.trim()) return parsed.split(';').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function numericOrBlank(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : '';
}

function booleanOrBlank(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return '';
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
