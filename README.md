# Interview Drill App

Mobile PWA for practicing interview talking points. Records your voice, transcribes via Whisper, grades via Claude.

## Setup

### 1. Deploy the Worker

```bash
cd worker
npm install
wrangler login
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

Note the Worker URL from the deploy output (e.g. `https://interview-drill.ACCOUNT.workers.dev`).

### 2. Update ALLOWED_ORIGIN

Edit `worker/wrangler.toml` — replace `REPLACE_WITH_GITHUB_PAGES_URL` with your GitHub Pages URL (e.g. `https://USERNAME.github.io`). Then redeploy: `wrangler deploy`

### 3. Deploy the Frontend

Push the `frontend/` folder contents to your GitHub repo root. Enable GitHub Pages on main branch.

### 4. Configure the App

Open the app on your iPhone. Tap the gear icon > Settings. Enter the Worker URL. Tap "Add to Home Screen" in Safari Share sheet.

### 5. Add Your Talking Points

Tap gear > Admin > Decks tab. Edit the stub cards to add your real talking points.
