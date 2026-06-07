# NursingWebApp

An AI-tutored clinical reasoning app for nursing education. Students work through
acute-care patient scenarios using a structured, Socratic learning flow, and their
performance is recorded in a database for faculty review.

The app is a static front end backed by serverless functions on **Netlify**, with a
**Supabase** Postgres database for storing student performance. The AI tutor can run
on **Claude**, **OpenAI**, or an **open-source model via OpenRouter**.

---

## What it does

Each exercise walks a student through a single clinical case (for example, a patient
with an evolving STEMI) in four phases:

1. **Self assessment** — the student lists what they already know about the case,
   unaided, as a record of their starting knowledge.
2. **Concept mastery** — a Socratic AI tutor works through the case one concept at a
   time, probing the student's reasoning and checking off each concept as it is
   demonstrated.
3. **Synthesis essay** — once all concepts are mastered, the student writes one
   integrated essay tying the concepts together, with primary-literature citations.
4. **Reflection** — the student compares where they started to what they learned.

Completed exercises produce a performance record (saved to Supabase) and a set of
spaced-repetition ("Leitner") review cards. A separate faculty dashboard reads the
stored records.

---

## Choosing the tutor model

The student app has a model picker in the header with three options:

- **Claude** (Anthropic) — the default
- **OpenAI (GPT)**
- **Open-Source Medical LLM** — any OpenAI-compatible endpoint. This project uses
  **OpenRouter**, which exposes many open models (including free ones) behind a
  single OpenAI-compatible API.

The selected provider is sent with each tutor request and resolved server-side in
`netlify/functions/claude-feedback.js`. Each option only works if its credentials
are configured (see Environment variables). If a provider isn't configured or
fails, the app falls back to a built-in offline demo tutor so the flow can still be
walked through.

The open-source / medical models are research and educational tools and are used
here as a learning tutor only — not for patient-facing clinical advice.

---

## Architecture

```
Browser (static HTML/JS)
  ├── index.html        Student app (four-phase flow + Leitner review + model picker)
  ├── faculty.html      Faculty dashboard
  ├── admin.html        Admin hub
  └── questions/*.json  Question sets (clinical cases + mastery concepts)
        │
        ▼
Netlify Functions (serverless)
  ├── claude-feedback.js     Tutor backend — routes to Claude / OpenAI / OpenRouter
  ├── submit-performance.js  Inserts a completed-exercise record into Supabase
  ├── faculty-performance.js Serves performance data to the faculty dashboard
  ├── verify-google-login.js Verifies institutional Google sign-in
  └── public-config.js       Exposes safe public config (e.g. OAuth client id)
        │
        ▼
Supabase (Postgres)
  └── public.performance     One row per completed exercise
```

State is also kept in the browser's local storage, so a student can resume an
in-progress exercise and export a JSON backup.

---

## Tech stack

- Front end: plain HTML, CSS, and JavaScript (no build step)
- Serverless: Netlify Functions (Node)
- Database: Supabase (Postgres, via the REST/PostgREST API)
- Auth: Google Sign-In (institutional accounts) with an email fallback
- AI providers: Anthropic, OpenAI, and OpenRouter (OpenAI-compatible)

---

## Setup

### 1. Create the database table

In the Supabase SQL Editor, create the `public.performance` table (schema in
`README-SETUP.md`). Its columns must match the fields written by
`submit-performance.js`. After running, you can confirm with:

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'performance';
```

### 2. Configure environment variables (Netlify)

Set these under **Site settings → Environment variables**. Mark every key/secret as
a secret. Only set the providers you intend to use; unset providers simply won't be
selectable in practice (they fall back to the demo tutor).

**Database (required)**

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<your-project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (server-side only) |
| `SUPABASE_TABLE` | `performance` |

**Claude (default tutor)**

| Variable | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `ANTHROPIC_MODEL` | a Claude model id (optional) |

**OpenAI (optional)**

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | your OpenAI key (requires prepaid credit) |
| `OPENAI_MODEL` | e.g. `gpt-4o` |

**Open-source model via OpenRouter (optional)**

| Variable | Value |
| --- | --- |
| `OSS_MEDICAL_API_URL` | `https://openrouter.ai/api/v1/chat/completions` |
| `OSS_MEDICAL_API_KEY` | your OpenRouter key (`sk-or-...`) |
| `OSS_MEDICAL_MODEL` | an OpenRouter model id, e.g. `nvidia/nemotron-3-super-120b-a12b:free` |

**Other**

| Variable | Value |
| --- | --- |
| `FACULTY_DASHBOARD_PASSWORD` | gate for the faculty dashboard |

> Environment-variable changes only take effect on a **new deploy**. After editing
> them, trigger **Deploys → Trigger deploy → Deploy site**.

### 3. Run locally

```bash
npm install -g netlify-cli
netlify login
netlify link
netlify dev   # serves the site + functions at localhost:8888
```

`netlify dev` reads the same variables from a local `.env` file (keep it in
`.gitignore`).

### 4. Deploy

The site deploys from this GitHub repository — pushing to `main` triggers a Netlify
build and publish.

---

## Verifying it works

Each function can be tested directly, without secrets in the command (they're read
from Netlify).

**Database write:**

```bash
curl -i -X POST https://<your-site>.netlify.app/.netlify/functions/submit-performance \
  -H "Content-Type: application/json" \
  -d '{"studentName":"Test","studentUUID":"test-0001","googleEmail":"test@example.com","topic":"Connectivity test","totalConcepts":6,"conceptsMastered":6,"isLate":false}'
```

**Tutor (swap `provider` for `anthropic`, `openai`, or `oss`):**

```bash
curl -i -X POST https://<your-site>.netlify.app/.netlify/functions/claude-feedback \
  -H "Content-Type: application/json" \
  -d '{"provider":"oss","system":"You are a tutor.","messages":[{"role":"user","content":"Say hello."}],"max_tokens":50}'
```

A `200` with a `"text"` (or `"ok": true`) field means that piece is working.

---

## Notes and caveats

- **OpenRouter reasoning models** (e.g. NVIDIA Nemotron) can return their answer in a
  `reasoning` field with empty `content`; disabling reasoning gives faster, cleaner
  replies for tutoring. Very large models can also be slow enough to hit Netlify's
  function timeout — a smaller model is usually a better fit for interactive chat.
- **Free OpenRouter models log prompts/outputs** to the provider. Don't send
  confidential data through them.
- **Concept check-off** depends on the tutor emitting a `CONCEPT_MASTERED:...` line;
  the strongest models follow this most reliably.
- **Secrets** (Supabase service key, API keys) belong only in Netlify environment
  variables — never in the client or committed to the repo.

---

## Privacy and data

Performance records include student identity (name, email) and their written work.
Database writes are server-side and protected by the Supabase secret key, with Row
Level Security enabled so the public/anon key cannot read or write the table. Handle
stored data in line with your institution's policies.

---

## License

MIT — see [LICENSE](LICENSE).