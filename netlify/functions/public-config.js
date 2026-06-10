// netlify/functions/public-config.js
//
// Public, non-secret configuration for the NursingWebApp frontend.
//
// IMPORTANT:
// - This function must only expose values that are safe to send to the browser.
// - Do NOT expose API keys, service role keys, database URLs, dashboard passwords,
//   Azure/OpenAI/Anthropic/NVIDIA keys, or any private credentials here.
//
// Used by index.html/admin.html to discover Google OAuth and safe UI defaults.

exports.handler = async function () {
  const config = {
    ok: true,

    // Google sign-in client ID is public by design.
    // Keep blank for local/email-only prototype mode.
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',

    // Safe frontend defaults. These are labels/provider IDs only, not secrets.
    defaultProvider: process.env.PUBLIC_DEFAULT_LLM_PROVIDER || 'anthropic',

    providers: [
      {
        value: 'anthropic',
        label: 'Claude'
      },
      {
        value: 'openai',
        label: 'OpenAI (GPT)'
      },
      {
        value: 'nemotron',
        label: 'NVIDIA: Nemotron 3 Ultra'
      },
      {
        value: 'ollama',
        label: 'Ollama GPT-OSS 20B'
      }
    ],

    // Current prototype requirement: name + Employee ID before session start.
    // Kathryn's expanded demographics can be added here later as safe field metadata.
    demographicFields: [
      {
        id: 'nurseName',
        label: 'Nurse full name',
        type: 'text',
        required: true
      },
      {
        id: 'employeeId',
        label: 'Employee ID',
        type: 'text',
        required: true
      },
      {
        id: 'email',
        label: 'Email',
        type: 'email',
        required: false
      }
    ],

    // The active question/scenario JSON path used by the static frontend.
    defaultQuestionSet: process.env.PUBLIC_DEFAULT_QUESTION_SET || 'nursing/acute-care',

    // Informational flags for the browser UI.
    features: {
      googleLoginEnabled: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      emailFallbackEnabled: true,
      adaptiveScenarioCount: true,
      postSessionTutoringOnly: true,
      evaluationExplanationsHidden: true
    }
  };

  return json(200, config);
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store, max-age=0'
    },
    body: JSON.stringify(body)
  };
}
