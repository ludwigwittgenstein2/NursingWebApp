# MedTutor Netlify Phase 1

This is the first Netlify-ready refactor of the Claude artifact.

## What changed

- Questions were moved out of `index.html` into `questions/qset_01.json`.
- The app now loads questions with `fetch('/questions/qset_01.json')`.
- The Claude API call was moved behind a Netlify Function: `/.netlify/functions/claude-feedback`.
- JSON export/import and localStorage behavior were preserved.
- Google Sheets and CWRU OAuth are not implemented in this phase.

## Local test

1. Install Node.js.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set your Anthropic key:

   ```bash
   cp .env.example .env
   ```

4. Start local Netlify dev server:

   ```bash
   npx netlify dev
   ```

## GitHub setup

1. Create a new GitHub repository.
2. Upload/push all files in this folder.
3. Do not commit `.env`.
4. The question files should live in `questions/`.

## Netlify setup

1. In Netlify, choose **Add new project**.
2. Choose **Import an existing project**.
3. Connect the GitHub repository.
4. Build command: leave blank or use `npm run build`.
5. Publish directory: `.`
6. Functions directory: `netlify/functions`.
7. Add environment variable:

   ```text
   ANTHROPIC_API_KEY=your_real_key
   ```

## Adding more question sets

Add more files:

```text
questions/qset_02.json
questions/qset_03.json
```

To load a different set manually, use:

```text
https://your-site.netlify.app/?qset=qset_02
```

Later, CWRU OAuth and Google Sheets can determine the question set automatically.

## Phase 2 targets

- Add CWRU Google OAuth login.
- Add roster/assignment lookup from Google Sheets.
- Add automatic performance submission to Google Sheets.
- Keep JSON export as backup.
