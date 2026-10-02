# AGENTS.md — working notes for AI assistants

Guidance for AI assistants editing this repo.

## What this is
NutriLog: a static PWA nutrition tracker (GitHub Pages) backed by Supabase (Auth, Postgres + RLS,
Realtime, Edge Functions). No framework and no bundler — plain ES modules loaded by `index.html`;
`npm run build` only checks paths/CSP/secrets and copies the site into `_site/`.
See README.md for setup and architecture.

## Layout
- `js/lib/` pure logic (nutrition + goal-date plans, body composition, smart-scale protocol, activity,
  import formats, stats, utils) — unit-tested, no DOM.
- `js/services/` Supabase client, auth, data layer (offline queue + cache), Bluetooth scale, barcode
  lookup, AI, reminders.
- `js/views/` screens; each `mountX(root)` returns a disposer. `js/app.js` does auth-gated routing;
  every route except the dashboard is lazy-loaded (`ROUTES[…].load`), and sheets used from other
  screens are opened through `views/lazy.js`. Navigation: Dashboard / Food / Progress / Measure /
  More (bottom tabs on phones, sidebar on desktop).
- Food logging is AI-first. "My foods" searches the user's own recent items + `favorite_foods`
  (`lib/food-library.js`). There is deliberately **no generic food database** — don't add one. The
  shared AI rules and the staple-food reference table live in `supabase/functions/_shared/`.
- `supabase/migrations/` schema + RLS; `supabase/functions/` Edge Functions (Deno, TypeScript).

## Guardrails
- **No secrets in the website.** Only the Supabase URL + anon/publishable key go in `js/config.js`.
  Gemini/Claude keys exist only as Edge Function secrets; call AI through `js/services/ai.js`.
- **XSS:** write markup only with the `html` tagged template + `setHTML` (auto-escapes). Never build
  inline `onclick` strings — the CSP blocks them; use `data-action` + `bindActions` or listeners.
- **Every user table has RLS** on `auth.uid()`. New tables need policies and a test in `tests/db/`.
- **Writes go through `js/services/data.js`** (queued, idempotent, client-generated ids) so offline
  retries never duplicate rows. Changes the server rejects move to `failed` (retry / discard from
  the sync pill) — never drop user data silently.
- **Water** is stored in ml (`water_logs.ml`, `user_preferences.water_goal_ml`); triggers keep the
  old `glasses` columns in sync for older clients.
- **Nutrition:** foods are per 100 g/ml; amounts scale linearly (`scaleNutrition`). Store unrounded
  values; round only for display. Custom goals (`is_custom`) must never be overwritten; automatic
  ones follow the latest weigh-in (`syncAutoTargets`). AI energy is always computed from macros.
- **Activities:** MET-based calories use the weight on the activity's date (`weightOn` in JS mirrors
  `public.weight_on()`); the database trigger is the source of truth — keep the two in sync.
- **Service worker:** when adding a JS file, add it to `SHELL` in `sw.js` (a test and the build
  enforce this); bump `VERSION` when shipping without the deploy workflow. Paths stay relative (the
  site lives under `/NutriLog/`).
- **Edge Function CORS** comes from `ALLOWED_ORIGINS` (default: the NutriLog GitHub Pages origin) —
  never `*`.
- **Layout:** cards must not overflow at 320 px; grids use `minmax(0, 1fr)`. The e2e suite checks
  every screen from 320 to 1440 px.
- Mount each view in a fresh container (app.js does this) so listeners don't leak between routes.

## Testing
`npm test` (unit + PGlite database/RLS tests), `npm run test:e2e` (Playwright against a mocked
Supabase; `E2E_SCREENSHOTS=dir` saves screenshots), `npm run test:functions`,
`npm run check:functions`, `npm run lint`, `npm run build`.
