# API Cost Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add monthly API cost tracking with transcription/grading breakdown, displayed in a new Usage tab within the admin screen.

**Architecture:** Worker calculates cost from actual Whisper/Claude API response usage data and returns it alongside existing response fields. Frontend appends cost entries to localStorage and aggregates them by month for display. Admin screen gets a third tab (Usage) alongside existing Decks and Settings tabs.

**Tech Stack:** Cloudflare Workers (ES modules), vanilla JS frontend, localStorage, no external dependencies.

**Spec:** `docs/superpowers/specs/2026-04-03-api-cost-tracker-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `worker/worker.js` | Modify | Add PRICING constants, extract usage from API responses, include `cost` in response JSON |
| `frontend/app.js` | Modify | Add `apiCosts` storage key, cost recording after API calls, Usage tab rendering, update tab switching for 3 tabs |
| `frontend/index.html` | Modify | Add Usage tab button to tab bar, add Usage tab panel HTML |
| `frontend/styles.css` | Modify | Update tab grid for 3 columns, add Usage tab layout styles |

---

### Task 1: Worker -- Add Cost Data to /transcribe Response

**Files:**
- Modify: `worker/worker.js` (lines 1-6 for constants, lines 58-119 for handleTranscribe)

- [ ] **Step 1: Add PRICING constants at top of file**

After the `CORS_HEADERS` and `corsResponse` definitions (after line 16), add:

```js
const PRICING = {
  whisper_per_minute: 0.006,
  haiku_input_per_token: 0.0000008,
  haiku_output_per_token: 0.000004,
};
```

- [ ] **Step 2: Extract duration and calculate cost in handleTranscribe**

In `handleTranscribe`, after `const result = await whisperRes.json();` (line 106), replace the return statement (lines 107-111) with:

```js
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
```

Note: `Math.round(...* 1000000) / 1000000` avoids floating point artifacts (6 decimal places for sub-cent precision).

- [ ] **Step 3: Verify worker deploys**

Run: `cd worker && npx wrangler deploy`

Expected: Successful deploy with no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/worker.js
git commit -m "feat(worker): return transcription cost from Whisper usage data"
```

---

### Task 2: Worker -- Add Cost Data to /grade Response

**Files:**
- Modify: `worker/worker.js` (lines 122-261 for handleGrade)

- [ ] **Step 1: Extract token usage and calculate cost in handleGrade**

In `handleGrade`, after the `gradeResult` shape validation block (after line 243), replace the return statement (lines 245-252) with:

```js
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
```

- [ ] **Step 2: Verify worker deploys**

Run: `cd worker && npx wrangler deploy`

Expected: Successful deploy with no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/worker.js
git commit -m "feat(worker): return grading cost from Claude token usage"
```

---

### Task 3: Frontend -- Record Cost Entries in localStorage

**Files:**
- Modify: `frontend/app.js` (lines 1-10 for STORAGE_KEYS, lines 468-500 for API calls)

- [ ] **Step 1: Add apiCosts to STORAGE_KEYS**

In the `STORAGE_KEYS` object (line 5), add after `workerUrl`:

```js
  apiCosts: 'api_costs',
```

- [ ] **Step 2: Add recordCost helper function**

After the `getWorkerUrl` function (after line 48), add:

```js
function recordCost(costData) {
  if (!costData || typeof costData.amount !== 'number') return;
  var costs = JSON.parse(localStorage.getItem(STORAGE_KEYS.apiCosts) || '[]');
  costs.push({
    date: new Date().toISOString().slice(0, 10),
    service: costData.service,
    amount: costData.amount,
  });
  localStorage.setItem(STORAGE_KEYS.apiCosts, JSON.stringify(costs));
}
```

- [ ] **Step 3: Record cost after transcribe call**

In the `transcribe` function, after `var data = await res.json();` (line 483), add before the return:

```js
  recordCost(data.cost);
```

- [ ] **Step 4: Record cost after grade call**

In the `grade` function, after `return await res.json();` (line 499), change to:

```js
  var data = await res.json();
  recordCost(data.cost);
  return data;
```

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): record API cost entries in localStorage"
```

---

### Task 4: Frontend -- Add Usage Tab to Admin HTML

**Files:**
- Modify: `frontend/index.html` (lines 129-150 for tab bar, after line 302 for new panel)

- [ ] **Step 1: Add Usage tab button to the tab bar**

In `index.html`, after the Settings tab button closing `</button>` (line 149), add before the closing `</div>` of the tab bar:

```html
        <button
          id="tab-usage"
          class="tab"
          type="button"
          role="tab"
          aria-selected="false"
          aria-controls="admin-usage-panel"
        >
          Usage
        </button>
```

- [ ] **Step 2: Add Usage tab panel**

After the closing `</div>` of the `admin-settings-panel` (find the div that ends the settings panel), add:

```html
      <div
        id="admin-usage-panel"
        class="tab-panel hidden"
        role="tabpanel"
        aria-labelledby="tab-usage"
      >
        <div class="panel-header">
          <div>
            <p class="eyebrow">API Spend</p>
            <h3 class="panel-title">Monthly cost breakdown</h3>
          </div>
        </div>

        <div class="usage-month-nav">
          <button id="btn-usage-prev" class="icon-btn" type="button" aria-label="Previous month">&#8592;</button>
          <span id="usage-month-label" class="usage-month-label"></span>
          <button id="btn-usage-next" class="icon-btn" type="button" aria-label="Next month">&#8594;</button>
        </div>

        <div id="usage-breakdown" class="usage-breakdown" aria-live="polite"></div>
      </div>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(html): add Usage tab and panel to admin screen"
```

---

### Task 5: Frontend -- Update Tab Switching for 3 Tabs

**Files:**
- Modify: `frontend/app.js` (lines 647-665 for switchAdminTab, lines 978+ for bindGlobalEvents)

- [ ] **Step 1: Rewrite switchAdminTab to support 3 tabs**

Replace the entire `switchAdminTab` function (lines 647-665) with:

```js
function switchAdminTab(tab) {
  var tabs = {
    decks: { tab: 'tab-decks', panel: 'admin-decks-panel' },
    settings: { tab: 'tab-settings', panel: 'admin-settings-panel' },
    usage: { tab: 'tab-usage', panel: 'admin-usage-panel' },
  };

  Object.keys(tabs).forEach(function (key) {
    var t = document.getElementById(tabs[key].tab);
    var p = document.getElementById(tabs[key].panel);
    if (key === tab) {
      t.classList.add('active');
      t.setAttribute('aria-selected', 'true');
      p.classList.remove('hidden');
    } else {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      p.classList.add('hidden');
    }
  });

  if (tab === 'decks') renderAdminDecks();
  if (tab === 'settings') renderAdminSettings();
  if (tab === 'usage') renderUsageTab();
}
```

- [ ] **Step 2: Add Usage tab click binding in bindGlobalEvents**

Find where the tab click listeners are bound (search for `tab-decks` addEventListener). Add after the settings tab listener:

```js
  document.getElementById('tab-usage').addEventListener('click', function () {
    switchAdminTab('usage');
  });
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): update tab switching to support Usage tab"
```

---

### Task 6: Frontend -- Render Usage Tab Content

**Files:**
- Modify: `frontend/app.js` (add after the `renderAdminSettings` / `bindAdminSettings` section, around line 974)

- [ ] **Step 1: Add usage month state variable**

At the top of the file with the other `let` declarations (around line 37), add:

```js
let usageMonth = null;
```

- [ ] **Step 2: Add getMonthCosts aggregation function**

After `bindAdminSettings` (around line 974), add:

```js
// ─── Admin: Usage Tab ───

function getMonthKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function getMonthLabel(monthKey) {
  var parts = monthKey.split('-');
  var date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function getMonthCosts(monthKey) {
  var costs = JSON.parse(localStorage.getItem(STORAGE_KEYS.apiCosts) || '[]');
  var whisper = 0;
  var haiku = 0;
  costs.forEach(function (entry) {
    if (!entry.date || !entry.date.startsWith(monthKey)) return;
    if (entry.service === 'whisper') whisper += entry.amount;
    if (entry.service === 'haiku') haiku += entry.amount;
  });
  return { whisper: whisper, haiku: haiku, total: whisper + haiku };
}
```

- [ ] **Step 3: Add renderUsageTab function**

Immediately after the above:

```js
function renderUsageTab() {
  var now = new Date();
  var currentMonthKey = getMonthKey(now);
  if (!usageMonth) usageMonth = currentMonthKey;

  document.getElementById('usage-month-label').textContent = getMonthLabel(usageMonth);
  document.getElementById('btn-usage-next').disabled = (usageMonth >= currentMonthKey);

  var data = getMonthCosts(usageMonth);
  var container = document.getElementById('usage-breakdown');

  if (data.total === 0) {
    container.innerHTML = '<p class="usage-empty">No usage recorded</p>';
    return;
  }

  var whisperPct = data.total > 0 ? Math.round((data.whisper / data.total) * 100) : 0;
  var haikuPct = data.total > 0 ? Math.round((data.haiku / data.total) * 100) : 0;

  container.innerHTML =
    '<div class="usage-row usage-total">' +
      '<span class="usage-label">Total</span>' +
      '<span class="usage-amount">$' + data.total.toFixed(2) + '</span>' +
    '</div>' +
    '<div class="usage-row">' +
      '<span class="usage-label">Transcription</span>' +
      '<span class="usage-amount">$' + data.whisper.toFixed(2) + ' <span class="usage-pct">(' + whisperPct + '%)</span></span>' +
    '</div>' +
    '<div class="usage-row">' +
      '<span class="usage-label">Grading</span>' +
      '<span class="usage-amount">$' + data.haiku.toFixed(2) + ' <span class="usage-pct">(' + haikuPct + '%)</span></span>' +
    '</div>';
}
```

- [ ] **Step 4: Add month navigation binding in bindGlobalEvents**

In `bindGlobalEvents`, add:

```js
  // Usage month navigation
  document.getElementById('btn-usage-prev').addEventListener('click', function () {
    var parts = usageMonth.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1 - 1);
    usageMonth = getMonthKey(d);
    renderUsageTab();
  });
  document.getElementById('btn-usage-next').addEventListener('click', function () {
    var currentMonthKey = getMonthKey(new Date());
    var parts = usageMonth.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1 + 1);
    var next = getMonthKey(d);
    if (next <= currentMonthKey) {
      usageMonth = next;
      renderUsageTab();
    }
  });
```

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): render Usage tab with monthly cost breakdown"
```

---

### Task 7: Styles -- Update Tab Grid and Add Usage Layout

**Files:**
- Modify: `frontend/styles.css` (lines 566-570 for tab-bar grid, add new usage styles)

- [ ] **Step 1: Update tab grid to 3 columns**

Change the `.tab-bar` grid from:

```css
  grid-template-columns: repeat(2, minmax(0, 1fr));
```

to:

```css
  grid-template-columns: repeat(3, minmax(0, 1fr));
```

- [ ] **Step 2: Add Usage tab styles**

After the existing `#admin-settings-panel` rule (after line 597), add:

```css
#admin-usage-panel {
  max-width: 680px;
}

.usage-month-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.usage-month-label {
  font-size: 1.1rem;
  font-weight: 600;
  min-width: 160px;
  text-align: center;
}

.usage-breakdown {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.usage-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.03);
}

.usage-row.usage-total {
  border-color: rgba(76, 201, 240, 0.42);
  background: var(--accent-soft);
}

.usage-label {
  font-weight: 600;
}

.usage-amount {
  font-variant-numeric: tabular-nums;
}

.usage-pct {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.usage-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 32px 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/styles.css
git commit -m "feat(styles): Usage tab layout and 3-column tab grid"
```

---

### Task 8: Deploy and Verify End-to-End

- [ ] **Step 1: Deploy worker**

Run: `cd worker && npx wrangler deploy`

Expected: Successful deploy.

- [ ] **Step 2: Push frontend to GitHub Pages**

Run: `git push`

Expected: GitHub Actions triggers Pages deploy.

- [ ] **Step 3: End-to-end verification**

Open the app on mobile. Practice one card (record, get grade). Then go to Admin > Usage tab. Verify:
- Current month is shown
- Total, Transcription, and Grading rows appear with non-zero values
- Percentages add up
- Month navigation works (prev goes back, next is disabled on current month)
- Past months with no data show "No usage recorded"

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: end-to-end verification adjustments"
git push
```
