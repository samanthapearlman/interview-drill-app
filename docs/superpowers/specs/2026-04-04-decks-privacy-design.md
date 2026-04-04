# Design: Decks Privacy — Move to Cloudflare KV

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Remove interview scripts from public GitHub repo; serve via authenticated Cloudflare Worker + KV

---

## Problem

`frontend/data/decks.json` contains sensitive interview talking points and is committed to a public GitHub repo. The content itself is sensitive, and the fact that the app exists at all (job searching) is also sensitive. Anyone who clones the repo can read the scripts — including past git history.

## Decision

Move decks out of the repo entirely. Store in Cloudflare KV, served via an authenticated `/decks` endpoint on the existing Cloudflare Worker. Scrub `decks.json` from git history using `git filter-repo`.

---

## Architecture

**New infrastructure:**
- Cloudflare KV namespace: `INTERVIEW_DECKS`
- Single KV key: `decks` — stores the full decks JSON (same structure as current `decks.json`)
- KV free tier is sufficient (1GB storage, 100k reads/day)

**New worker endpoints:**
- `GET /decks` — returns `{ "decks": [...] }` from KV (same shape as current `decks.json`); requires auth token
- `POST /decks` — accepts `{ "decks": [...] }` body, writes to KV; requires auth token

**Auth token:**
- A long random string stored as Cloudflare Worker secret `API_TOKEN`
- Also stored in the app's localStorage under a new storage key (`api_token`)
- Set once in admin Settings screen; sent as `Authorization: Bearer {token}` on every worker request
- All four endpoints (`/decks GET`, `/decks POST`, `/transcribe`, `/grade`) validate this token

**Frontend:**
- Remove static `decks.json` load; replace with `loadDecks()` call to `GET /decks` at startup
- Admin deck save calls `POST /decks` instead of writing to localStorage override
- Remove `decks_override` localStorage key — KV is now the single source of truth
- Add token field to admin Settings screen

**Repo:**
- Delete `frontend/data/decks.json`
- Scrub file from full git history via `git filter-repo --path frontend/data/decks.json --invert-paths`
- Force-push to main after history rewrite

---

## Data Flow

### App startup
1. Frontend loads
2. Calls `GET /decks` with `Authorization: Bearer {token}`
3. Worker validates token → fetches `decks` from KV → returns JSON
4. Frontend renders deck list

**On auth failure:** app shows error state — "Could not load decks. Check your worker URL and token in Settings." Practice screen locked until decks load.

### Admin deck edit
1. User edits deck in admin panel → taps Save
2. Frontend calls `POST /decks` with updated decks JSON + auth token
3. Worker validates token → writes to KV → returns 200
4. Frontend updates in-memory state

**On save failure:** inline error shown in admin panel; in-memory state not updated; user can retry.

### Token setup (one-time)
1. Generate a random token. In Git Bash: `openssl rand -hex 32`. In PowerShell: `[System.Web.Security.Membership]::GeneratePassword(40,0)` or just use a password manager to generate a 40+ character random string.
2. Add as Cloudflare Worker secret: `wrangler secret put API_TOKEN`
3. Redeploy worker
4. Open app Settings on iPhone → paste token → Save

### KV seed (one-time, before deleting decks.json)
1. Copy contents of `frontend/data/decks.json` into KV via Cloudflare dashboard
   - KV namespace → `INTERVIEW_DECKS` → Create entry → key: `decks`, value: paste JSON
2. Verify `/decks` returns correct data before proceeding with file deletion

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Token missing or wrong | Worker returns 403; app shows settings error |
| KV read fails | Worker returns 502; app shows error state |
| KV write fails on deck save | Worker returns 502; admin panel shows inline error |
| KV empty (not seeded) | `GET /decks` returns empty array; app renders empty deck list; admin panel shows "No decks found" |

---

## Git History Scrub

**Tool:** `git filter-repo` (install via `pip install git-filter-repo` or `pip3 install git-filter-repo` on Windows)

**Command:**
```bash
git filter-repo --path frontend/data/decks.json --invert-paths
```

**Steps:**
1. Ensure all local changes are committed
2. Note your remote URL first: `git remote get-url origin`
3. Run filter-repo command — rewrites all commits that touched `decks.json`
4. Re-add the remote (filter-repo removes it as a safety measure): `git remote add origin <url from step 2>`
5. Force-push to origin main: `git push origin main --force`
6. Verify on GitHub that file is gone from all commits

**Note:** This is destructive and cannot be undone without a backup. Take a local copy of `decks.json` before running (to use as KV seed content).

**Commit messages:** `git filter-repo` rewrites file content, not commit messages. Check recent commit messages for any content that references specific talking points.

---

## Implementation Order

1. Create KV namespace in Cloudflare dashboard: Workers & Pages → KV → Create namespace → name it `INTERVIEW_DECKS`. Then bind it in `wrangler.toml` (add `[[kv_namespaces]]` block with namespace ID).
2. Seed KV with current `decks.json` content (via Cloudflare dashboard)
3. Add `API_TOKEN` worker secret + token validation middleware to worker
4. Add `GET /decks` and `POST /decks` endpoints to worker; deploy
5. Update frontend: replace static load with `loadDecks()`, update admin save, add token field to Settings; clear `decks_override` from localStorage on first successful KV load
6. Smoke test on device — verify decks load and save correctly
7. Delete `frontend/data/decks.json` from repo
8. Run `git filter-repo` to scrub history
9. Force-push to main
10. Verify on GitHub Pages that app still works

---

## Out of Scope

- Encrypting localStorage (session history, costs) — separate effort
- Rate limiting and request auth (token work above covers auth; rate limiting is a separate PR)
- Multi-user access or per-user decks
