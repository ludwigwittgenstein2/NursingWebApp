// netlify/functions/submit-performance.js
//
// Receives a completed-exercise record from the app and inserts it into a
// Supabase table using the REST (PostgREST) API.
//
// Env vars (set in Netlify -> Site settings -> Environment variables):
//   SUPABASE_URL                e.g. https://yazplthctxldwrpeubxw.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   the SECRET service_role key (server-side only!)
//   SUPABASE_TABLE              optional, defaults to "performance"
//
// The service_role key bypasses Row Level Security, so this server-side insert
// works even with RLS enabled. NEVER put the service_role key in the HTML/client.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TABLE = process.env.SUPABASE_TABLE || 'performance';

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
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  // string-or-null, number-or-null, boolean, json-or-null helpers
  const s = (v) => (v === '' || v == null ? null : String(v));
  const n = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null);
  const b = (v) => !!v;
  const j = (v) => (v == null ? null : v);

  const row = {
    student_name: s(p.studentName),
    student_uuid: s(p.studentUUID),
    google_sub: s(p.googleSub),
    google_email: s(p.googleEmail),
    google_name: s(p.googleName),
    google_hd: s(p.googleHd),

    course_id: s(p.courseId),
    course_name: s(p.courseName),
    class_id: s(p.classId),
    academic_year: s(p.academicYear),
    question_set_id: s(p.questionSetId),

    question_id: s(p.questionId),
    week: s(p.week),
    week_label: s(p.weekLabel),
    question_number: s(p.questionNumber),
    topic: s(p.topic),
    question: s(p.question),

    release_date: s(p.releaseDate),
    deadline: s(p.deadline),
    started_at: s(p.startedAt),
    completed_at: s(p.completedAt),
    is_late: b(p.isLate),

    total_concepts: n(p.totalConcepts),
    concepts_mastered: n(p.conceptsMastered),
    total_exchanges: n(p.totalExchanges),
    time_minutes: n(p.timeMinutes),

    self_concepts: j(p.selfConcepts),
    socratic_history: j(p.socraticHistory),
    confirmed_roadmap: j(p.confirmedRoadmap),
    mastered_concepts: j(p.masteredConcepts),
    essay_text: s(p.essayText),
    essay_citations: j(p.essayCitations),
    reflection_text: s(p.reflectionText),
    reflection_learned: s(p.reflectionLearned),

    raw: p
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        prefer: 'return=representation'
      },
      body: JSON.stringify(row)
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    if (!response.ok) {
      return json(response.status, {
        ok: false,
        error: (data && (data.message || data.error)) || 'Supabase insert failed',
        details: data
      });
    }

    return json(200, { ok: true, inserted: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    return json(500, { ok: false, error: error.message || 'Server error' });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  };
}