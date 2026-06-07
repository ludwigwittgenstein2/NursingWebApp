# NursingWebApp

An AI-tutored clinical reasoning app for nursing education. Students work through
acute-care patient scenarios using a structured, Socratic learning flow, and their
performance is recorded for faculty review.

The app is a static front end backed by serverless functions, deployed on Netlify,
with a Supabase Postgres database for storing student performance.
---

## What it does

Each exercise walks a student through a single clinical case (for example, a
patient with an evolving STEMI) in four phases:

1. **Self assessment** — the student lists what they already know about the case,
   unaided, as a record of their starting knowledge.
2. **Concept mastery** — a Socratic AI tutor works through the case one concept at
   a time, probing the student's reasoning and checking off each concept as it is
   demonstrated.
3. **Synthesis essay** — once all concepts are mastered, the student writes one
   integrated essay tying the concepts together, with primary-literature citations.
4. **Reflection** — the student compares where they started to what they learned.

Completed exercises produce a performance record and a set of spaced-repetition
("Leitner") review cards. A separate faculty dashboard reads the stored records.

---

## Choosing the tutor model

The student app includes a model picker in the header with three options:

- **Claude** (Anthropic) — default
- **OpenAI (GPT)**
- **Open-Source Medical LLM** — any OpenAI-compatible endpoint serving a model such
  as OpenBioLLM, Med42, MedGemma, or Palmyra-Med (via HuggingFace, OpenRouter,
  Together, or a self-hosted vLLM / Ollama server)

The choice is sent with each tutor request and resolved server-side. Each option
only works if its credentials are configured (see Environment variables); an
unconfigured provider falls back to a built-in offline demo tutor so the flow can
still be walked through.

The open-source medical models are research/educational tools and are framed here
as a learning tutor only — not for patient-facing clinical advice.

---

## Architecture

```
Browser (static HTML/JS)
  ├── index.html        Student app (the four-phase flow + Leitner review)
  ├── faculty.html      Faculty dashboard (reads stored performance)
  ├── admin.html        Admin hub
  └── questions/*.json  Question sets (clinical cases + mastery concepts)
        │
        ▼
Netlify Functions (serverless)
  ├── claude-feedback.js     Tutor backend — routes to Claude / OpenAI / OSS model
  ├── submit-performance.js  Inserts a completed-exercise record into Supabase
  ├── faculty-performance.js Serves performance data to the faculty dashboard
  ├── verify-google-login.js Verifies institutional Google sign-in
  └── public-config.js       Exposes safe public config (e.g. OAuth client id)
        │
        ▼
Supabase (Postgres)
  └── public.performance     One row per completed exercise
```

State is also kept in the browser's local storage so a student can resume an
in-progress exercise and export a JSON backup.

---

## Tech stack

- Front end: plain HTML, CSS, and JavaScript (no build step)
- Serverless: Netlify Functions (Node)
- Database: Supabase (Postgres, accessed via the REST/PostgREST API)
- Auth: Google Sign-In (institutional accounts) with an email fallback
- LLM providers: Anthropic, OpenAI, and any OpenAI-compatible host

---

## Setup

### 1. Create the database table

In the Supabase SQL Editor, run the schema in `README-SETUP.md` to create the
`public.performance` table. The table's columns must match the fields written by
`submit-performance.js` (student identity, course/question metadata, timing,
concept counts, essay, reflection, and JSON columns for the richer data).

### 2. Configure environment variables (Netlify)

Set these under **Site settings → Environment variables**:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude tutor |
| `ANTHROPIC_MODEL` | Claude model id (optional) |
| `OPENAI_API_KEY` | OpenAI tutor (optional) |
| `OPENAI_MODEL` | OpenAI model id, e.g. `gpt-4o` (optional) |
| `OSS_MEDICAL_API_URL` | OpenAI-compatible endpoint for the open-source model (optional) |
| `OSS_MEDICAL_API_KEY` | Key for that endpoint (optional) |
| `OSS_MEDICAL_MODEL` | Open-source model id (optional) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (server-side only — never expose) |
| `SUPABASE_TABLE` | Table name, defaults to `performance` |
| `FACULTY_DASHBOARD_PASSWORD` | Gate for the faculty dashboard |

The Supabase secret key is privileged and must only ever live in Netlify
environment variables, never in the client.

### 3. Run locally

```bash
npm install -g netlify-cli
netlify login
netlify link
netlify dev
```

`netlify dev` serves the static site and the functions together at
`http://localhost:8888`, reading the same environment variables (from a local
`.env` file, which should be git-ignored).

### 4. Deploy

The site deploys from this GitHub repository. Pushing to `main` triggers a
Netlify build and publish.

---

## Repository layout

```
index.html              Student app
faculty.html            Faculty dashboard
admin.html              Admin hub
questions/              Question set JSON (clinical cases + concepts)
netlify/functions/      Serverless backend
netlify.toml            Netlify configuration
README-SETUP.md         Database schema and setup notes
package.json            Dependencies / scripts
```

---

## Privacy and data

Performance records include student identity (name, email) and their written work.
Database writes are server-side and protected by the Supabase secret key with Row
Level Security enabled, so the public/anon key cannot read or write the table.
Handle the stored data in line with your institution's policies.

---

## License

MIT — see [LICENSE](LICENSE).