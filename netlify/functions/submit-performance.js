const crypto = require('crypto');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  const required = [
    'GOOGLE_SHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY'
  ];

  for (const key of required) {
    if (!process.env[key]) {
      return jsonResponse(500, {
        error: `Missing ${key} environment variable.`
      });
    }
  }

  try {
    const record = JSON.parse(event.body || '{}');
    const accessToken = await getGoogleAccessToken();

    const row = [
      new Date().toISOString(),
      record.studentName || '',
      record.studentUUID || '',
      record.courseId || '',
      record.courseName || '',
      record.questionId || '',
      record.topic || '',
      record.completedAt || '',
      String(record.isLate ?? ''),
      String(record.conceptsMastered ?? ''),
      String(record.totalConcepts ?? ''),
      String(record.timeMinutes ?? ''),
      String(record.totalExchanges ?? ''),
      JSON.stringify(record)
    ];

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const range = 'PerformanceLog!A:N';

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [row] })
      }
    );

    const text = await response.text();
    const data = safeJson(text);

    if (!response.ok) {
      return jsonResponse(response.status, data);
    }

    return jsonResponse(200, {
      ok: true,
      updatedRange: data.updates?.updatedRange || null
    });
  } catch (error) {
    return jsonResponse(500, {
      error: error.message || 'Server error'
    });
  }
};

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const claimSet = {
    iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedToken = `${encodedHeader}.${encodedClaimSet}`;

  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsignedToken)
    .sign(privateKey, 'base64');

  const jwt = `${unsignedToken}.${base64UrlFromBase64(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const text = await response.text();
  const data = safeJson(text);

  if (!response.ok) {
    throw new Error(`Google token error: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

function base64UrlEncode(input) {
  return base64UrlFromBase64(Buffer.from(input).toString('base64'));
}

function base64UrlFromBase64(base64) {
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
