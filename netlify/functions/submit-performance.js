const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      return jsonResponse(500, { error: `Missing ${key} environment variable.` });
    }
  }

  try {
    const record = JSON.parse(event.body || '{}');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const insertRow = {
      student_name: record.studentName || '',
      student_uuid: record.studentUUID || '',
      google_sub:   record.googleSub || '',
      google_email: record.googleEmail || '',
      google_name:  record.googleName || '',
      google_hd:    record.googleHd || '',

      class_id:        record.classId || '',
      academic_year:   record.academicYear || '',
      question_set_id: record.questionSetId || '',
      course_id:       record.courseId || '',
      course_name:     record.courseName || '',

      question_id:     record.questionId || '',
      week:            String(record.week ?? ''),
      week_label:      record.weekLabel || '',
      question_number: String(record.questionNumber ?? ''),
      topic:           record.topic || '',
      release_date:    record.releaseDate || '',
      deadline:        record.deadline || '',

      started_at:        record.startedAt || '',
      completed_at:      record.completedAt || '',
      is_late:           String(record.isLate ?? ''),
      total_concepts:    String(record.totalConcepts ?? ''),
      concepts_mastered: String(record.conceptsMastered ?? ''),
      total_exchanges:   String(record.totalExchanges ?? ''),
      time_minutes:      String(record.timeMinutes ?? ''),

      self_concepts:     record.selfConcepts || [],
      mastered_concepts: record.masteredConcepts || {},
      essay_text:        record.essayText || '',
      essay_citations:   record.essayCitations || {},
      reflection_text:   record.reflectionText || '',
      reflection_learned: record.reflectionLearned || '',

      full_record: record
    };

    const { data, error } = await supabase
      .from('performance')
      .insert(insertRow)
      .select('id')
      .single();

    if (error) {
      return jsonResponse(500, { error: error.message });
    }

    return jsonResponse(200, { ok: true, id: data.id });
  } catch (error) {
    return jsonResponse(500, { error: error.message || 'Server error' });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}