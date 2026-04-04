# Decks Privacy — Move to Cloudflare KV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove interview scripts from the public GitHub repo and serve them from Cloudflare KV behind an authenticated worker endpoint.

**Architecture:** A new Cloudflare KV namespace (`INTERVIEW_DECKS`) stores decks as a single JSON blob. Two new worker endpoints (`GET /decks`, `POST /decks`) serve and accept updates, both protected by a shared secret token (`API_TOKEN` worker secret). The frontend fetches decks from the worker at startup instead of loading `data/decks.json` from the repo.

**Tech Stack:** Cloudflare Workers, Cloudflare KV, vanilla JS (no build step), wrangler CLI

---

## File Map

| File | Change |
|------|--------|
| `worker/wrangler.toml` | Add KV namespace binding |
| `worker/worker.js` | Add `validateToken()`, token check in main handler, `handleGetDecks()`, `handlePostDecks()`, update route table |
| `frontend/index.html` | Add API token input + save button to Settings tab |
| `frontend/app.js` | Add `apiToken` to `STORAGE_KEYS`, add `getApiToken()`, replace `loadDecks()`, rename `saveDecksOverride()` → `saveDecksToKV()` (async), update all call sites, update `btn-reset-decks` handler, update `renderAdminSettings()` and `bindAdminSettings()` |
| `frontend/data/decks.json` | Delete |

**No new files are created.** All changes are modifications to existing files, except the deletion.

---

## Task 1: Cloudflare infrastructure setup (manual, no code)

This task is done in the Cloudflare dashboard. No code changes. Must be completed before deploying the worker.

- [ ] **Step 1: Back up decks.json locally**

  Copy `frontend/data/decks.json` to a safe local location (e.g. Desktop). This is your KV seed content and your recovery file if something goes wrong.

- [ ] **Step 2: Create the KV namespace**

  In the Cloudflare dashboard:
  - Go to Workers & Pages → KV
  - Click "Create namespace"
  - Name it `INTERVIEW_DECKS`
  - Click "Add"
  - Copy the **Namespace ID** (a long hex string like `abc123...`) — you'll need it in Task 2

- [ ] **Step 3: Seed KV with current decks content**

  Still in KV dashboard:
  - Click into the `INTERVIEW_DECKS` namespace
  - Click "Add entry"
  - Key: `decks`
  - Value: paste the full contents of `frontend/data/decks.json`
  - Click "Add entry"

- [ ] **Step 4: Verify the entry exists**

  In the KV namespace view, confirm you see one entry with key `decks`. Click it to verify the JSON looks correct.

---

## Task 2: Bind KV namespace in wrangler.toml

**Files:**
- Modify: `worker/wrangler.toml`

- [ ] **Step 1: Add KV namespace binding**

  Open `worker/wrangler.toml`. Replace the full file contents with:

  ```toml
  name = "interview-drill"
  main = "worker.js"
  compatibility_date = "2024-01-01"

  [vars]
  # Update ALLOWED_ORIGIN after GitHub Pages URL is confirmed.
  # Must match exactly: https://USERNAME.github.io or https://USERNAME.github.io/REPO
  # No trailing slash. Redeploy after updating.
  ALLOWED_ORIGIN = "https://samanthapearlman.github.io"

  [[kv_namespaces]]
  binding = "INTERVIEW_DECKS"
  id = "REPLACE_WITH_KV_NAMESPACE_ID"
  ```

  Replace `REPLACE_WITH_KV_NAMESPACE_ID` with the actual namespace ID from Task 1 Step 2.

- [ ] **Step 2: Commit**

  ```bash
  git add worker/wrangler.toml
  git commit -m "feat(worker): bind INTERVIEW_DECKS KV namespace"
  ```

---

## Task 3: Worker — token validation + /decks endpoints

**Files:**
- Modify: `worker/worker.js`

This task replaces the full contents of `worker/worker.js`. The complete new file is shown below with all changes integrated (token validation middleware, two new route handlers).

- [ ] **Step 1: Replace worker.js with updated version**

  Replace the entire contents of `worker/worker.js` with:

  ```javascript
  const CORS_HEADERS = (origin) => ({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });

  function corsResponse(status, body, origin) {
    return new Response(body, {
      status,
      headers: {
        ...CORS_HEADERS(origin),
        'Content-Type': 'application/json',
      },
    });
  }

  function validateToken(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return env.API_TOKEN && token === env.API_TOKEN;
  }

  const PRICING = {
    whisper_per_minute: 0.006,
    haiku_input_per_token: 0.0000008,
    haiku_output_per_token: 0.000004,
  };

  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin') || '';
      const allowedOrigin = env.ALLOWED_ORIGIN;

      if (request.method === 'OPTIONS') {
        if (origin === allowedOrigin) {
          return new Response(null, {
            status: 204,
            headers: CORS_HEADERS(allowedOrigin),
          });
        }
        return new Response('Forbidden', { status: 403 });
      }

      if (origin !== allowedOrigin) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!validateToken(request, env)) {
        return corsResponse(403, JSON.stringify({ error: 'forbidden' }), allowedOrigin);
      }

      if (url.pathname === '/transcribe' && request.method === 'POST') {
        return handleTranscribe(request, env, allowedOrigin);
      }

      if (url.pathname === '/grade' && request.method === 'POST') {
        return handleGrade(request, env, allowedOrigin);
      }

      if (url.pathname === '/decks' && request.method === 'GET') {
        return handleGetDecks(request, env, allowedOrigin);
      }

      if (url.pathname === '/decks' && request.method === 'POST') {
        return handlePostDecks(request, env, allowedOrigin);
      }

      return corsResponse(
        404,
        JSON.stringify({ error: 'not_found' }),
        allowedOrigin,
      );
    },
  };

  async function handleGetDecks(request, env, allowedOrigin) {
    try {
      const raw = await env.INTERVIEW_DECKS.get('decks');
      if (!raw) {
        return corsResponse(200, JSON.stringify({ decks: [] }), allowedOrigin);
      }
      return corsResponse(200, raw, allowedOrigin);
    } catch (e) {
      console.error('handleGetDecks exception:', e);
      return corsResponse(
        500,
        JSON.stringify({ error: 'decks_load_failed', message: e.message }),
        allowedOrigin,
      );
    }
  }

  async function handlePostDecks(request, env, allowedOrigin) {
    try {
      const body = await request.json();
      if (!body || !Array.isArray(body.decks)) {
        return corsResponse(400, JSON.stringify({ error: 'invalid_body' }), allowedOrigin);
      }
      await env.INTERVIEW_DECKS.put('decks', JSON.stringify(body));
      return corsResponse(200, JSON.stringify({ ok: true }), allowedOrigin);
    } catch (e) {
      console.error('handlePostDecks exception:', e);
      return corsResponse(
        500,
        JSON.stringify({ error: 'decks_save_failed', message: e.message }),
        allowedOrigin,
      );
    }
  }

  async function handleTranscribe(request, env, allowedOrigin) {
    try {
      const formData = await request.formData();
      const audioFile = formData.get('audio');

      if (!audioFile) {
        return corsResponse(
          400,
          JSON.stringify({ error: 'missing_audio' }),
          allowedOrigin,
        );
      }

      const mimeType = audioFile.type || 'audio/mp4';
      const filename =
        mimeType.includes('mp4') || mimeType.includes('aac')
          ? 'recording.mp4'
          : 'recording.webm';

      const whisperForm = new FormData();
      whisperForm.append('file', audioFile, filename);
      whisperForm.append('model', 'whisper-1');
      whisperForm.append('language', 'en');

      const whisperRes = await fetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: whisperForm,
        },
      );

      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        console.error('Whisper error:', whisperRes.status, err);
        return corsResponse(
          502,
          JSON.stringify({
            error: 'transcription_failed',
            message: 'Whisper API error',
          }),
          allowedOrigin,
        );
      }

      const result = await whisperRes.json();
      const durationSec = result.duration || 0;
      const cost = {
        service: 'whisper',
        amount: Math.round((durationSec / 60) * PRICING.whisper_per_minute * 1000000) / 1000000,
        unit: 'usd',
        duration_sec: durationSec,
      };

      return corsResponse(
        200,
        JSON.stringify({ transcript: result.text, cost }),
        allowedOrigin,
      );
    } catch (e) {
      console.error('handleTranscribe exception:', e);
      return corsResponse(
        500,
        JSON.stringify({ error: 'transcription_failed', message: e.message }),
        allowedOrigin,
      );
    }
  }

  async function handleGrade(request, env, allowedOrigin) {
    try {
      const body = await request.json();
      const { transcript, prompt, target, keyPoints } = body;

      if (!transcript || !prompt || !target || !keyPoints) {
        return corsResponse(
          400,
          JSON.stringify({ error: 'missing_fields' }),
          allowedOrigin,
        );
      }

      const gradingPrompt = `You are an interview coach grading a practice response.

  PROMPT: ${prompt}

  TARGET TALKING POINT:
  ${target}

  KEY POINTS TO HIT:
  ${keyPoints.join('\n')}

  CANDIDATE RESPONSE:
  ${transcript}

  Grade this response. Return JSON only, no other text:
  {
    "score": <1-10 integer>,
    "callouts": [
      "Good: <specific observation>",
      "Weak: <specific observation>",
      "Missing: <specific observation if applicable>"
    ]
  }

  Rules:
  - Score 9-10: hit all key points, strong delivery, clear landing
  - Score 7-8: hit most key points, minor gaps or delivery issues
  - Score 5-6: hit some key points, clear gaps
  - Score below 5: missed key points or significant delivery problems
  - Callouts must be specific to THIS response, not generic coaching advice
  - 2-3 callouts max
  - Include a "Good" callout when a key point was hit clearly
  - Include a "Weak" callout if delivery trailed off, ran too long, or lacked a landing
  - Include a "Missing" callout only if a key point was completely absent from the response
  - keyPoints are the primary scoring criteria; target text provides full context`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content: gradingPrompt }],
        }),
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text();
        console.error('Claude error:', claudeRes.status, err);
        return corsResponse(
          502,
          JSON.stringify({ error: 'grading_failed', message: 'Claude API error' }),
          allowedOrigin,
        );
      }

      const claudeData = await claudeRes.json();
      const rawText = claudeData.content[0].text.trim();

      let gradeResult;

      try {
        gradeResult = JSON.parse(rawText);
      } catch (parseErr) {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          try {
            gradeResult = JSON.parse(jsonMatch[0]);
          } catch {
            console.error('Failed to parse Claude JSON:', rawText);
            return corsResponse(
              502,
              JSON.stringify({
                error: 'grading_failed',
                message: 'Malformed response',
              }),
              allowedOrigin,
            );
          }
        } else {
          console.error('No JSON in Claude response:', rawText);
          return corsResponse(
            502,
            JSON.stringify({
              error: 'grading_failed',
              message: 'Malformed response',
            }),
            allowedOrigin,
          );
        }
      }

      if (
        typeof gradeResult.score !== 'number' ||
        !Array.isArray(gradeResult.callouts)
      ) {
        return corsResponse(
          502,
          JSON.stringify({
            error: 'grading_failed',
            message: 'Invalid grade shape',
          }),
          allowedOrigin,
        );
      }

      const usage = claudeData.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cost = {
        service: 'haiku',
        amount: Math.round((inputTokens * PRICING.haiku_input_per_token + outputTokens * PRICING.haiku_output_per_token) * 1000000) / 1000000,
        unit: 'usd',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };

      return corsResponse(
        200,
        JSON.stringify({
          score: gradeResult.score,
          callouts: gradeResult.callouts,
          cost,
        }),
        allowedOrigin,
      );
    } catch (e) {
      console.error('handleGrade exception:', e);
      return corsResponse(
        500,
        JSON.stringify({ error: 'grading_failed', message: e.message }),
        allowedOrigin,
      );
    }
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add worker/worker.js
  git commit -m "feat(worker): add token auth and /decks KV endpoints"
  ```

---

## Task 4: Add API_TOKEN secret and deploy worker

This task is done in your terminal from the `worker/` directory. No code changes.

- [ ] **Step 1: Generate an API token**

  In Git Bash:
  ```bash
  openssl rand -hex 32
  ```
  Or in PowerShell:
  ```powershell
  -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 40 | % {[char]$_})
  ```
  Copy the output. Save it somewhere safe (you'll paste it into the app settings on your phone in Task 7).

- [ ] **Step 2: Add the secret to Cloudflare**

  ```bash
  cd worker
  wrangler secret put API_TOKEN
  ```
  Paste your token when prompted. Press Enter.

  Expected output:
  ```
  ✔ Success! Uploaded secret API_TOKEN
  ```

- [ ] **Step 3: Deploy**

  ```bash
  wrangler deploy
  ```

  Expected output includes:
  ```
  Published interview-drill (...)
  https://interview-drill.ACCOUNT.workers.dev
  ```

- [ ] **Step 4: Smoke test GET /decks**

  In Git Bash, replacing values with your actual worker URL and token:
  ```bash
  curl -s \
    -H "Origin: https://samanthapearlman.github.io" \
    -H "Authorization: Bearer YOUR_TOKEN_HERE" \
    https://interview-drill.ACCOUNT.workers.dev/decks
  ```

  Expected: JSON response containing your decks array (the content you seeded in Task 1).

  If you get `{"error":"forbidden"}`, double-check the token matches what you set with `wrangler secret put`.

- [ ] **Step 5: Smoke test POST /decks (write + read back)**

  ```bash
  curl -s -X POST \
    -H "Origin: https://samanthapearlman.github.io" \
    -H "Authorization: Bearer YOUR_TOKEN_HERE" \
    -H "Content-Type: application/json" \
    -d '{"decks":[{"id":"test","name":"Test","cards":[]}]}' \
    https://interview-drill.ACCOUNT.workers.dev/decks
  ```

  Expected: `{"ok":true}`

  Then GET again to confirm the test deck is there. Then restore your real decks:
  ```bash
  # Paste the real decks JSON from your backup file
  curl -s -X POST \
    -H "Origin: https://samanthapearlman.github.io" \
    -H "Authorization: Bearer YOUR_TOKEN_HERE" \
    -H "Content-Type: application/json" \
    -d @/path/to/your/decks-backup.json \
    https://interview-drill.ACCOUNT.workers.dev/decks
  ```

---

## Task 5: Frontend — add apiToken to STORAGE_KEYS and add getApiToken()

**Files:**
- Modify: `frontend/app.js` (lines 1–11 and ~46–50)

- [ ] **Step 1: Add apiToken to STORAGE_KEYS**

  In `frontend/app.js`, find the `STORAGE_KEYS` object (lines 3–11):
  ```javascript
  const STORAGE_KEYS = {
    adminPinOverride: 'admin_pin_override',
    decksOverride: 'decks_override',
    sessionHistory: 'session_history',
    workerUrl: 'worker_url',
    apiCosts: 'api_costs',
  };
  ```

  Replace with:
  ```javascript
  const STORAGE_KEYS = {
    adminPinOverride: 'admin_pin_override',
    decksOverride: 'decks_override',
    sessionHistory: 'session_history',
    workerUrl: 'worker_url',
    apiToken: 'api_token',
    apiCosts: 'api_costs',
  };
  ```

- [ ] **Step 2: Add getApiToken() after getWorkerUrl()**

  In `frontend/app.js`, find `getWorkerUrl()` (lines 48–50):
  ```javascript
  function getWorkerUrl() {
    return localStorage.getItem(STORAGE_KEYS.workerUrl) || '';
  }
  ```

  Add `getApiToken()` immediately after it:
  ```javascript
  function getWorkerUrl() {
    return localStorage.getItem(STORAGE_KEYS.workerUrl) || '';
  }

  function getApiToken() {
    return localStorage.getItem(STORAGE_KEYS.apiToken) || '';
  }
  ```

- [ ] **Step 3: Verify no syntax errors**

  Open `frontend/index.html` in a browser (double-click the file). Open DevTools → Console. Confirm no errors on load.

---

## Task 6: Frontend HTML — add API token input to Settings tab

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Add token input after the Worker URL save button**

  In `frontend/index.html`, find this block (around line 278–280):
  ```html
          <button id="btn-save-worker-url" class="action-btn primary small" type="button">
            Save Worker URL
          </button>
  ```

  Replace with:
  ```html
          <button id="btn-save-worker-url" class="action-btn primary small" type="button">
            Save Worker URL
          </button>

          <label class="setting-group" for="input-api-token">
            <span>API Token</span>
            <input
              id="input-api-token"
              type="password"
              placeholder="Paste your API token"
              autocomplete="off"
            >
          </label>
          <button id="btn-save-api-token" class="action-btn primary small" type="button">
            Save Token
          </button>
  ```

- [ ] **Step 2: Verify HTML renders correctly**

  Open `frontend/index.html` in a browser. Navigate to Admin → Settings tab. Confirm you see:
  - Cloudflare Worker URL field + Save button
  - API Token field + Save Token button
  - Admin PIN section below

---

## Task 7: Frontend — update renderAdminSettings() and bindAdminSettings()

**Files:**
- Modify: `frontend/app.js` (lines 944–995)

- [ ] **Step 1: Update renderAdminSettings() to populate token field**

  Find `renderAdminSettings()` (around line 946):
  ```javascript
  function renderAdminSettings() {
    var urlInput = document.getElementById('input-worker-url');
    if (urlInput) urlInput.value = getWorkerUrl();
  }
  ```

  Replace with:
  ```javascript
  function renderAdminSettings() {
    var urlInput = document.getElementById('input-worker-url');
    if (urlInput) urlInput.value = getWorkerUrl();
    var tokenInput = document.getElementById('input-api-token');
    if (tokenInput) tokenInput.value = getApiToken();
  }
  ```

- [ ] **Step 2: Add token save handler in bindAdminSettings()**

  Find `bindAdminSettings()`. After the Worker URL save handler block (the one ending with `updateConfigBanner();`), add the token save handler. The Worker URL block looks like:
  ```javascript
  document.getElementById('btn-save-worker-url').addEventListener('click', function () {
    var val = document.getElementById('input-worker-url').value.trim();
    // Remove trailing slash
    if (val.endsWith('/')) val = val.slice(0, -1);
    localStorage.setItem(STORAGE_KEYS.workerUrl, val);
    updateConfigBanner();
  });
  ```

  Add immediately after it:
  ```javascript
  document.getElementById('btn-save-api-token').addEventListener('click', function () {
    var val = document.getElementById('input-api-token').value.trim();
    localStorage.setItem(STORAGE_KEYS.apiToken, val);
  });
  ```

- [ ] **Step 3: Verify in browser**

  Open `frontend/index.html`. Go to Admin → Settings. Type a test value in the API Token field. Click "Save Token". Reload the page, go back to Settings — confirm the token field is populated with what you typed.

---

## Task 8: Frontend — replace loadDecks() with KV fetch

**Files:**
- Modify: `frontend/app.js` (lines 88–106)

- [ ] **Step 1: Replace loadDecks()**

  Find the `loadDecks()` function (lines 88–102):
  ```javascript
  async function loadDecks() {
    var override = localStorage.getItem(STORAGE_KEYS.decksOverride);
    if (override) {
      try {
        decksData = JSON.parse(override);
        return decksData;
      } catch (e) {
        localStorage.removeItem(STORAGE_KEYS.decksOverride);
      }
    }
    var response = await fetch('data/decks.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('decks_load_failed');
    decksData = await response.json();
    return decksData;
  }
  ```

  Replace with:
  ```javascript
  async function loadDecks() {
    var workerUrl = getWorkerUrl();
    var token = getApiToken();

    if (!workerUrl || !token) {
      decksData = { decks: [] };
      return decksData;
    }

    var response = await fetch(workerUrl + '/decks', {
      headers: { 'Authorization': 'Bearer ' + token },
    });

    if (!response.ok) throw new Error('decks_load_failed');

    localStorage.removeItem(STORAGE_KEYS.decksOverride);

    decksData = await response.json();
    return decksData;
  }
  ```

- [ ] **Step 2: Update the DOMContentLoaded error handler to surface config errors**

  Find the `DOMContentLoaded` handler (around line 1187):
  ```javascript
  document.addEventListener('DOMContentLoaded', async function () {
    try {
      await loadDecks();
    } catch (e) {
      console.error('Failed to load decks:', e);
    }

    renderDeckSelect();
    updateConfigBanner();
    bindGlobalEvents();
    showScreen(SCREENS.deckSelect);
  });
  ```

  Replace with:
  ```javascript
  document.addEventListener('DOMContentLoaded', async function () {
    try {
      await loadDecks();
    } catch (e) {
      console.error('Failed to load decks:', e);
      showInlineError('Could not load decks. Check your worker URL and token in Settings.');
    }

    renderDeckSelect();
    updateConfigBanner();
    bindGlobalEvents();
    showScreen(SCREENS.deckSelect);
  });
  ```

- [ ] **Step 3: Verify loadDecks with no config**

  Open `frontend/index.html` in a browser with no worker URL or token in localStorage (open an Incognito window). Deck list should show empty — no error thrown, no crash. This is the expected state before setup.

---

## Task 9: Frontend — replace saveDecksOverride() → saveDecksToKV() and update all call sites

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Replace saveDecksOverride() with saveDecksToKV()**

  Find `saveDecksOverride()` (lines 104–106):
  ```javascript
  function saveDecksOverride() {
    localStorage.setItem(STORAGE_KEYS.decksOverride, JSON.stringify(decksData));
  }
  ```

  Replace with:
  ```javascript
  async function saveDecksToKV() {
    var workerUrl = getWorkerUrl();
    var token = getApiToken();
    if (!workerUrl || !token) return;

    var response = await fetch(workerUrl + '/decks', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(decksData),
    });

    if (!response.ok) throw new Error('decks_save_failed');
  }
  ```

- [ ] **Step 2: Update weight increment call (fire-and-forget, no await)**

  Find this block (around line 605):
  ```javascript
  var sourceCard = deck.cards.find(function (c) { return c.id === card.id; });
  if (sourceCard) {
    sourceCard.weight = (Number(sourceCard.weight) || 1) + 1;
    saveDecksOverride();
  }
  ```

  Replace with:
  ```javascript
  var sourceCard = deck.cards.find(function (c) { return c.id === card.id; });
  if (sourceCard) {
    sourceCard.weight = (Number(sourceCard.weight) || 1) + 1;
    saveDecksToKV();
  }
  ```

  Note: No `await` here. This is intentional — weight updates during practice are fire-and-forget.

- [ ] **Step 3: Update delete deck handler**

  Find the delete deck click handler (around line 724):
  ```javascript
  if (!window.confirm(msg)) return;
  decksData.decks = decksData.decks.filter(function (d) { return d.id !== deck.id; });
  saveDecksOverride();
  adminExpandedDeckIds.delete(deck.id);
  renderAdminDecks();
  ```

  Replace with:
  ```javascript
  if (!window.confirm(msg)) return;
  decksData.decks = decksData.decks.filter(function (d) { return d.id !== deck.id; });
  try {
    await saveDecksToKV();
  } catch (e) {
    alert('Failed to save. Try again.');
    return;
  }
  adminExpandedDeckIds.delete(deck.id);
  renderAdminDecks();
  ```

  Also change the outer `function ()` to `async function ()` for this event handler. Find:
  ```javascript
  deleteBtn.addEventListener('click', function () {
  ```
  Replace with:
  ```javascript
  deleteBtn.addEventListener('click', async function () {
  ```

- [ ] **Step 4: Update add card handler**

  Find the add card block (around line 777):
  ```javascript
  deck.cards.push({
    ...
  });
  saveDecksOverride();
  adminSelection = ...
  ```

  Replace `saveDecksOverride();` with:
  ```javascript
  try {
    await saveDecksToKV();
  } catch (e) {
    alert('Failed to save. Try again.');
    return;
  }
  ```

  Change the enclosing `addEventListener('click', function ()` to `addEventListener('click', async function ()`.

- [ ] **Step 5: Update reset card weight handler**

  Find the `resetWeightBtn.addEventListener` block (around line 877):
  ```javascript
  resetWeightBtn.addEventListener('click', function () {
    card.weight = 1;
    adminDraft.weight = 1;
    saveDecksOverride();
    renderAdminDecks();
  });
  ```

  Replace with:
  ```javascript
  resetWeightBtn.addEventListener('click', async function () {
    card.weight = 1;
    adminDraft.weight = 1;
    try {
      await saveDecksToKV();
    } catch (e) {
      alert('Failed to save. Try again.');
      return;
    }
    renderAdminDecks();
  });
  ```

- [ ] **Step 6: Update save card handler**

  Find the save card block (around line 896):
  ```javascript
  Object.assign(deck.cards[cardIndex], {
    ...
  });
  saveDecksOverride();
  closeCardEditor();
  renderAdminDecks();
  ```

  Replace `saveDecksOverride();` with:
  ```javascript
  try {
    await saveDecksToKV();
  } catch (e) {
    alert('Failed to save. Try again.');
    return;
  }
  ```

  Change the enclosing `saveCardBtn.addEventListener('click', function ()` to `saveCardBtn.addEventListener('click', async function ()`.

- [ ] **Step 7: Update delete card handler**

  Find the delete card block (around line 917):
  ```javascript
  deleteCardBtn.addEventListener('click', function () {
    if (!window.confirm('Delete this card?')) return;
    deck.cards.splice(cardIndex, 1);
    saveDecksOverride();
    closeCardEditor();
    renderAdminDecks();
  });
  ```

  Replace with:
  ```javascript
  deleteCardBtn.addEventListener('click', async function () {
    if (!window.confirm('Delete this card?')) return;
    deck.cards.splice(cardIndex, 1);
    try {
      await saveDecksToKV();
    } catch (e) {
      alert('Failed to save. Try again.');
      return;
    }
    closeCardEditor();
    renderAdminDecks();
  });
  ```

- [ ] **Step 8: Update reset all weights handler**

  Find (around line 980):
  ```javascript
  document.getElementById('btn-reset-weights').addEventListener('click', function () {
    if (!window.confirm('Reset all card weights to 1 across all decks?')) return;
    decksData.decks.forEach(function (deck) {
      deck.cards.forEach(function (card) { card.weight = 1; });
    });
    saveDecksOverride();
    alert('All weights reset to 1.');
  });
  ```

  Replace with:
  ```javascript
  document.getElementById('btn-reset-weights').addEventListener('click', async function () {
    if (!window.confirm('Reset all card weights to 1 across all decks?')) return;
    decksData.decks.forEach(function (deck) {
      deck.cards.forEach(function (card) { card.weight = 1; });
    });
    try {
      await saveDecksToKV();
    } catch (e) {
      alert('Failed to save. Try again.');
      return;
    }
    alert('All weights reset to 1.');
  });
  ```

- [ ] **Step 9: Update add deck handler**

  Find (around line 1138):
  ```javascript
  decksData.decks.push({ id: id, name: name.trim(), cards: [] });
  saveDecksOverride();
  adminExpandedDeckIds.add(id);
  renderAdminDecks();
  ```

  Replace `saveDecksOverride();` with:
  ```javascript
  try {
    await saveDecksToKV();
  } catch (e) {
    alert('Failed to save. Try again.');
    return;
  }
  ```

  Change the enclosing `addEventListener('click', function ()` for the add deck button to `addEventListener('click', async function ()`.

- [ ] **Step 10: Update "Reset to server" button**

  Find the `btn-reset-decks` handler (around line 1147):
  ```javascript
  document.getElementById('btn-reset-decks').addEventListener('click', async function () {
    if (!window.confirm('Reset all decks to the server version? Local edits will be lost.')) return;
    localStorage.removeItem(STORAGE_KEYS.decksOverride);
    try {
      var response = await fetch('data/decks.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('fetch failed');
      decksData = await response.json();
    } catch (e) {
      alert('Failed to fetch server decks. Check your connection.');
      return;
    }
    adminExpandedDeckIds.clear();
    renderAdminDecks();
    renderDeckSelect();
  });
  ```

  Replace with:
  ```javascript
  document.getElementById('btn-reset-decks').addEventListener('click', async function () {
    if (!window.confirm('Reset all decks from KV? Local edits will be lost.')) return;
    try {
      await loadDecks();
    } catch (e) {
      alert('Failed to reload decks. Check your worker URL and token.');
      return;
    }
    adminExpandedDeckIds.clear();
    renderAdminDecks();
    renderDeckSelect();
  });
  ```

- [ ] **Step 11: Verify no remaining references to saveDecksOverride**

  ```bash
  grep -n "saveDecksOverride" frontend/app.js
  ```

  Expected: no output. If any remain, update them to `saveDecksToKV()`.

- [ ] **Step 12: Commit frontend changes**

  ```bash
  git add frontend/app.js frontend/index.html
  git commit -m "feat(frontend): load and save decks via authenticated KV worker endpoint"
  ```

---

## Task 10: End-to-end smoke test

No code changes. Verify the full flow works before deleting decks.json.

- [ ] **Step 1: Push to GitHub Pages**

  ```bash
  git push origin main
  ```

  Wait ~60 seconds for GitHub Pages to deploy.

- [ ] **Step 2: Open the app on your iPhone**

  Navigate to `https://samanthapearlman.github.io`. Confirm decks do NOT load (empty list) — expected because the token isn't set yet on this device.

- [ ] **Step 3: Configure settings**

  Open Admin → Settings:
  - Paste your worker URL → Save Worker URL
  - Paste your API token → Save Token

- [ ] **Step 4: Reload and verify decks load**

  Close and reopen the app. Confirm your decks appear in the deck list.

- [ ] **Step 5: Test admin deck edit**

  Open Admin → Decks. Edit a card. Save it. Reload the app. Confirm the edit persisted.

- [ ] **Step 6: Confirm DevTools doesn't expose scripts**

  On desktop, open `https://samanthapearlman.github.io` in an Incognito window. Open DevTools → Network tab. Reload. Confirm there is no request to `data/decks.json` and no decks content in any response (since no token is set).

---

## Task 11: Delete decks.json and commit

- [ ] **Step 1: Delete the file**

  ```bash
  git rm frontend/data/decks.json
  ```

- [ ] **Step 2: Commit the deletion**

  ```bash
  git commit -m "security: remove decks.json from repo — content moved to Cloudflare KV"
  ```

- [ ] **Step 3: Push**

  ```bash
  git push origin main
  ```

- [ ] **Step 4: Verify app still works**

  Reload `https://samanthapearlman.github.io` on your iPhone. Confirm decks still load (from KV, not the file).

---

## Task 12: Scrub git history with git filter-repo

This is destructive and rewrites all commit history. Do not skip the backup step.

- [ ] **Step 1: Verify your local decks backup exists**

  Confirm you have a local copy of `decks.json` content saved from Task 1 Step 1. If not, export from KV first via the dashboard before proceeding.

- [ ] **Step 2: Check your current remote URL**

  ```bash
  git remote get-url origin
  ```

  Copy this URL. You will need it in Step 5.

- [ ] **Step 3: Install git-filter-repo if not already installed**

  In Git Bash:
  ```bash
  pip install git-filter-repo
  ```
  Or:
  ```bash
  pip3 install git-filter-repo
  ```

  Verify:
  ```bash
  git filter-repo --version
  ```
  Expected: prints a version number.

- [ ] **Step 4: Run filter-repo to scrub decks.json from all history**

  From the repo root:
  ```bash
  git filter-repo --path frontend/data/decks.json --invert-paths
  ```

  Expected output: lines showing commits being rewritten. No errors.

- [ ] **Step 5: Re-add the remote (filter-repo removes it)**

  ```bash
  git remote add origin YOUR_REMOTE_URL_FROM_STEP_2
  ```

- [ ] **Step 6: Force-push to main**

  ```bash
  git push origin main --force
  ```

- [ ] **Step 7: Verify on GitHub**

  Open your repo on GitHub. Check a few old commits — confirm `frontend/data/decks.json` no longer appears in any commit's file list. Also search the repo for your name or a distinctive phrase from your talking points to confirm it's gone.

- [ ] **Step 8: Final smoke test**

  Reload `https://samanthapearlman.github.io` on your iPhone. Confirm the app still loads and decks are present. The app now reads only from KV — the file is gone from both the live repo and all historical commits.
