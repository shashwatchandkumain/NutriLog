# AGENTS.md — working notes for AI assistants

Guidance for Codex (or any AI) editing this repo.

## What this is
A single-page PWA diet tracker. **All app logic, markup, and CSS live in `index.html`** (~7.6k
lines). There is no build step, no framework, no bundler. Edit the file directly and open it in a
browser to test.

## Architecture at a glance
- **State**: module-scoped globals near the top of the `<script>` (`sb`, `userId`, `goals`,
  `aiProvider`, `secureMode`, `bodyStats`, `currentDate`, ...). Persistence via `localStorage`
  (aliased as `LS`).
- **Backend**: Supabase (tables `meals`, `user_settings`, `activities`, `weight_logs`).
  Queries are plain `sb.from('table')...` filtered by `user_id`.
- **Auth / Secure Mode**: `secureMode` true ⇒ `initSupabase()` calls
  `sb.auth.signInAnonymously()` and sets `userId = auth.uid()`; RLS policies enforce
  per-user access. Fresh installs default to Secure Mode; existing installs stay legacy until the
  user upgrades in Settings (`upgradeSecureMode()`).
- **AI**: `callAI` / `callAIVision` / `callAIChat` dispatch to `geminiCall` or `claudeCall`.
  Gemini is the free default. The Gemini key is sent as the `x-goog-api-key` header (never in the
  URL).
- **Food DB**: `FOOD_DB` global from `food_db.js`, per-100g (`{n,c,p,cb,f,fb}`). Used by
  `searchFoodDB` / `showFoodDropdown` for instant, offline, no-AI logging.

## Conventions / guardrails
- **XSS**: any user-, AI-, or API-derived string written via `innerHTML` MUST go through
  `esc()`. For values that end up inside an inline handler, stash an object in a variable and
  read it in the handler (see `lastBarcodeProduct` / `logBarcodeFood`) instead of string-building
  the call.
- **Service worker**: after changing `index.html`, bump `CACHE_NAME` in `sw.js` so clients fetch
  the new version. HTML and API requests are network-first; static assets are cache-first.
- **No secrets in the repo.** Keys are entered by the user at runtime and stored in
  `localStorage`. Never hard-code keys.
- **Keep it single-file.** Don't introduce a build system or split `index.html` unless asked.
- Match the existing terse style (short helpers, `let`/`const`, template literals).

## Quick testing
Open `index.html` directly in a browser, or serve the folder (`python3 -m http.server`) so the
service worker and manifest load. You need a Supabase project + Gemini key to exercise data/AI
paths.

## Known rough edges (candidates for future work)
- `food_db.js`: some deep-fried items carry oil-level fat/calorie values per 100g (e.g. poori,
  bhatura, several pakoras/samosas) that look too high — worth a data-quality pass.
- All logic in one file makes testing hard; there are no automated tests.
- No real account system; multi-device sharing only exists in legacy mode.
