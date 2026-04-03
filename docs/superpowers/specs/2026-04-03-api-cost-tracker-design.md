# API Cost Tracker -- Design Spec

## Purpose

Track per-call API costs from Whisper (transcription) and Haiku 4.5 (grading) so Sam can see monthly spend inside the app. Costs display on a new "Usage" tab within the admin screen.

## Decision Log

- Monthly totals with transcription/grading breakdown (not per-session logs)
- Worker calculates cost from actual API response usage data, returns in response
- Frontend stores cost entries in localStorage (no KV/D1)
- Lives inside admin behind PIN, not on home screen
- Admin gets three tabs: Decks | Settings | Usage

## Worker Changes

### Pricing Constants

```js
const PRICING = {
  whisper_per_minute: 0.006,
  haiku_input_per_token: 0.0000008,   // $0.80 / 1M
  haiku_output_per_token: 0.000004,   // $4.00 / 1M
};
```

### /transcribe Response

Current response: `{ transcript: "..." }`

New response:

```json
{
  "transcript": "...",
  "cost": {
    "service": "whisper",
    "amount": 0.0042,
    "unit": "usd",
    "duration_sec": 42
  }
}
```

Cost calculation: Whisper returns `duration` in its response body (seconds of audio processed). Multiply `duration / 60 * PRICING.whisper_per_minute`.

### /grade Response

Current response: `{ score: 8, callouts: [...] }`

New response:

```json
{
  "score": 8,
  "callouts": ["..."],
  "cost": {
    "service": "haiku",
    "amount": 0.0003,
    "unit": "usd",
    "input_tokens": 380,
    "output_tokens": 95
  }
}
```

Cost calculation: Claude API returns `usage.input_tokens` and `usage.output_tokens` in the response body. Multiply each by the per-token rate and sum.

### Backward Compatibility

The `cost` field is additive. Frontend code that doesn't read it is unaffected. No breaking changes.

## Frontend Changes

### New localStorage Key

Key: `api_costs`

Value: JSON array of cost entries.

```json
[
  { "date": "2026-04-03", "service": "whisper", "amount": 0.0042 },
  { "date": "2026-04-03", "service": "haiku", "amount": 0.0003 }
]
```

After each successful `/transcribe` or `/grade` call, the frontend appends a cost entry if `response.cost` exists. This is graceful -- if the worker hasn't been updated yet, no cost entry is written.

Add `apiCosts` to the existing `STORAGE_KEYS` object.

### Admin Tab Structure

Current admin screen has deck editor and settings (worker URL, PIN) in a single scrollable view.

New structure: three tabs at the top of the admin screen.

| Tab | Contents |
|-----|----------|
| Decks | Existing deck editor (default active tab) |
| Settings | Worker URL field + Admin PIN field (extracted from current layout) |
| Usage | Monthly cost view (new) |

Tab bar is a simple row of buttons with an active state underline. Matches existing dark theme.

### Usage Tab Layout

```
April 2026            [<]  [>]

Total           $2.47
Transcription   $2.18  (88%)
Grading         $0.29  (12%)
```

- Month/year header with prev/next arrows
- Three rows: total, transcription subtotal, grading subtotal
- Percentages shown inline
- If no data for the selected month, show "No usage recorded"
- Current month is the default view
- Month navigation does not go past the current month

### Cost Aggregation Logic

On rendering the Usage tab:
1. Read `api_costs` from localStorage
2. Filter entries where `date` starts with the selected month string (e.g. "2026-04")
3. Sum `amount` for `service === "whisper"` and `service === "haiku"` separately
4. Display total, each subtotal, and percentage of total

### Updated STORAGE_KEYS

```js
const STORAGE_KEYS = {
  adminPinOverride: 'admin_pin_override',
  decksOverride: 'decks_override',
  sessionHistory: 'session_history',
  workerUrl: 'worker_url',
  apiCosts: 'api_costs',
};
```

## Files to Modify

| File | Change |
|------|--------|
| `worker/worker.js` | Add PRICING constants, extract usage from Whisper/Claude responses, include `cost` in response JSON |
| `frontend/app.js` | Add `apiCosts` storage key, append cost entries after API calls, add tab switching logic, add Usage tab render function, extract Settings into its own tab |
| `frontend/index.html` | Add tab bar to admin section, add Usage tab container, restructure Settings into a tab pane |
| `frontend/styles.css` | Tab bar styles, Usage tab layout styles |

## Out of Scope

- Cross-device sync (KV/D1)
- Per-session or per-rep cost detail
- Cost alerts or budget limits
- Historical pricing changes (update constants manually when rates change)
