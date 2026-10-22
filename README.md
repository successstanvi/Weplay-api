# WePlay UID Lookup API — Vercel deployment

Vercel-ready Node.js serverless adaptation of the original Playwright API. Keeps `GET /lookup?uid=...`, `POST /lookup` with `{"uid":"..."}`, and `GET /health`.

## Deploy
1. Extract this ZIP and push its contents to a GitHub repository.
2. Import that repository in Vercel (Framework Preset: **Other**).
3. Use Node.js 20+ and deploy. Vercel installs dependencies from `package.json`.
4. Test `/health`, then `/lookup?uid=92661060`.

## Environment variables (optional)
- `WEPLAY_URL` — defaults to `https://weplayapp.com/en-IN/recharge`
- `RESULT_TIMEOUT_MS` — defaults to `15000`
- `NAVIGATION_TIMEOUT_MS` — defaults to `20000`
- `CACHE_TTL_MS` — defaults to `300000`
- `CACHE_MAX_ENTRIES` — defaults to `10000`
- `BROWSER_CONCURRENCY` — per warm function instance, clamped to 1–10 (default 5)

## Important Vercel limits
This uses Chromium in a serverless function and is best-effort. Cold starts are slower than a persistent Node server; warm-instance cache and in-flight deduplication are not shared across all Vercel instances. Vercel may scale separate instances, so the concurrency setting is per instance and does **not** guarantee 50 simultaneous lookups globally. WePlay can throttle or change its page UI. If you need reliable sustained 50-way browser concurrency, deploy the original persistent-server version to a container host instead.

The API scrapes the visible recharge form and does not call an undocumented WePlay API endpoint. Use only UIDs you are authorized to query. Consider adding authentication and rate limiting before exposing it publicly.
