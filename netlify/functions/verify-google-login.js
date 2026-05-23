exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return jsonResponse(500, { error: 'Missing GOOGLE_OAUTH_CLIENT_ID environment variable.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const credential = body.credential;

    if (!credential) {
      return jsonResponse(400, { error: 'Missing Google credential.' });
    }

    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
    const response = await fetch(verifyUrl);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return jsonResponse(401, { error: 'Invalid Google token.', details: data });
    }

    if (data.aud !== process.env.GOOGLE_OAUTH_CLIENT_ID) {
      return jsonResponse(401, { error: 'Google token audience mismatch.' });
    }

    if (!data.email_verified) {
      return jsonResponse(401, { error: 'Google email is not verified.' });
    }

    const allowedDomains = (process.env.ALLOWED_GOOGLE_DOMAINS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const email = String(data.email || '').toLowerCase();
    const hd = String(data.hd || '').toLowerCase();
    const emailDomain = email.includes('@') ? email.split('@').pop() : '';

    if (allowedDomains.length > 0) {
      const allowed = allowedDomains.includes(hd) || allowedDomains.includes(emailDomain);
      if (!allowed) {
        return jsonResponse(403, {
          error: 'This Google account is not in an allowed domain.',
          email,
          hd
        });
      }
    }

    return jsonResponse(200, {
      ok: true,
      user: {
        googleSub: data.sub,
        email: data.email,
        emailVerified: data.email_verified === 'true' || data.email_verified === true,
        name: data.name || '',
        givenName: data.given_name || '',
        familyName: data.family_name || '',
        picture: data.picture || '',
        hd: data.hd || ''
      }
    });
  } catch (error) {
    return jsonResponse(500, {
      error: error.message || 'Server error'
    });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
