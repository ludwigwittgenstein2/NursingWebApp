const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FACULTY_DASHBOARD_PASSWORD'];
  for (const key of required) {
    if (!process.env[key]) {
      return jsonResponse(500, { error: `Missing ${key} environment variable.` });
    }
  }

  try {
    const body = JSON.parse(event.body || '{}');
    if (body.password !== process.env.FACULTY_DASHBOARD_PASSWORD) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const [perfRes, studRes, paRes] = await Promise.all([
      supabase.from('performance').select('*').order('completed_at', { ascending: false }),
      supabase.from('students').select('*'),
      supabase.from('pas').select('*')
    ]);

    if (perfRes.error) {
      return jsonResponse(500, { error: perfRes.error.message });
    }

    return jsonResponse(200, {
      ok: true,
      performance: { rows: (perfRes.data || []).map(mapPerformanceRow) },
      students:    { rows: (studRes.data || []).map(mapStudentRow) },
      pas:         { rows: (paRes.data || []).map(mapPaRow) }
    });
  } catch (error) {
    return jsonResponse(500, { error: error.message || 'Server error' });
  }
};

function mapPerformanceRow(r) {
  return {
    submittedAt: r.created_at || '',
    studentName: r.student_name || '',
    studentUUID: r.student_uuid || '',
    googleSub: r.google_sub || '',
    googleEmail: r.google_email || '',
    googleName: r.google_name || '',
    googleHd: r.google_hd || '',
    classId: r.class_id || '',
    academicYear: r.academic_year || '',
    questionSetId: r.question_set_id || '',
    courseId: r.course_id || '',
    courseName: r.course_name || '',
    questionId: r.question_id || '',
    week: r.week || '',
    weekLabel: r.week_label || '',
    questionNumber: r.question_number || '',
    topic: r.topic || '',
    releaseDate: r.release_date || '',
    deadline: r.deadline || '',
    startedAt: r.started_at || '',
    completedAt: r.completed_at || '',
    isLate: r.is_late || '',
    totalConcepts: r.total_concepts || '',
    conceptsMastered: r.concepts_mastered || '',
    totalExchanges: r.total_exchanges || '',
    timeMinutes: r.time_minutes || '',
    fullRecordJson: r.full_record ? JSON.stringify(r.full_record) : ''
  };
}

function mapStudentRow(s) {
  return {
    googleEmail: s.google_email || '',
    studentName: s.student_name || '',
    studentUUID: s.student_uuid || '',
    classId: s.class_id || '',
    courseId: s.course_id || '',
    assignedPAEmail: s.assigned_pa_email || '',
    active: String(s.active ?? '')
  };
}

function mapPaRow(p) {
  return {
    paEmail: p.pa_email || '',
    paName: p.pa_name || '',
    active: String(p.active ?? '')
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}