exports.handler = async function() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || ''
    })
  };
};
