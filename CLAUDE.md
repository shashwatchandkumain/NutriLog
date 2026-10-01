# CLAUDE.md — working notes for AI assistants

Guidance for AI assistants editing this repo.

## What this is
NutriLog: a static PWA nutrition tracker (GitHub Pages) backed by Supabase (Auth, Postgres + RLS,
Realtime, Edge Functions). No framework and no build step — plain ES modules loaded by `index.html`.
See README.md for setup and architecture.

## Layout
- `js/lib/` pure logic (nutrition + goal-date plans, body composition, smart-scale protocol, activity,
  import formats, stats, utils) — unit-tested, no DOM.
- `js/services/` Supabase client, auth, data layer (offline queue + cache), Bluetooth scale, barcode
  lookup, AI, reminders.
- `js/views/` screens; each `mountX(root)` returns a disposer. `js/app.js` does auth-gated routing.
- Food logging is AI-first; there is no local food database. The shared AI rules and the staple-food
  reference table live in `supabase/functions/_shared/` (`nutrition.ts`, `reference-foods.ts`).
- `supabase/migrations/` schema + RLS; `supabase/functions/` Edge Functions (Deno, TypeScript).

## Guardrails
- **No secrets in the website.** Only the Supabase URL + anon/publishable key go in `js/config.js`.
  Gemini/Claude keys exist only as Edge Function secrets; call AI through `js/services/ai.js`.
- **XSS:** write markup only with the `html` tagged template + `setHTML` (auto-escapes). Never build
  inline `onclick` strings — the CSP blocks them; use `data-action` + `bindActions` or listeners.
- **Every user table has RLS** on `auth.uid()`. New tables need policies and a test in `tests/db/`.
- **Writes go through `js/services/data.js`** (queued, idempotent, client-generated ids) so offline
  retries never duplicate rows.
- **Nutrition:** foods are per 100 g/ml; amounts scale linearly (`scaleNutrition`). Store unrounded
  values; round only for display. Custom goals (`is_custom`) must never be overwritten; automatic
  ones follow the latest weigh-in (`syncAutoTargets`). AI energy is always computed from macros.
- **Activities:** MET-based calories use the weight on the activity's date (`weightOn` in JS mirrors
  `public.weight_on()`); the database trigger is the source of truth — keep the two in sync.
- **Service worker:** when adding a JS file, add it to `SHELL` in `sw.js` (a test enforces this);
  bump `VERSION` when shipping without the deploy workflow.
- Mount each view in a fresh container (app.js does this) so listeners don't leak between routes.

## Testing
`npm test` (unit + PGlite database/RLS tests), `npm run test:e2e` (Playwright against a mocked
Supabase), `npm run test:functions`, `npm run check:functions`, `npm run lint`.
