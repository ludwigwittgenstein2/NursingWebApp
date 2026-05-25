const crypto = require('crypto');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  const required = [
    'GOOGLE_SHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'FACULTY_DASHBOARD_PASSWORD'
  ];

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

    const accessToken = await getGoogleAccessToken();
    const sheetId = process.env.GOOGLE_SHEET_ID;

    const [performance, students, pas] = await Promise.all([
      readSheetRange(sheetId, accessToken, 'PerformanceLog!A:AG'),
      readSheetRange(sheetId, accessToken, 'Students!A:H'),
      readSheetRange(sheetId, accessToken, 'PAs!A:F')
    ]);

    return jsonResponse(200, {
      ok: true,
      performance,
      students,
      pas
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

async function readSheetRange(sheetId, accessToken, range) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const text = await response.text();
  const data = safeJson(text);

  if (!response.ok) {
    throw new Error(`Google Sheets read error for ${range}: ${JSON.stringify(data)}`);
  }

  const values = data.values || [];

  if (values.length === 0) {
    return {
      range,
      headers: [],
      rows: []
    };
  }

  const headers = values[0];
  const rows = values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || '';
    });
    return obj;
  });

  return {
    range,
    headers,
    rows
  };
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
