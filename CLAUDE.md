# CLAUDE.md — working notes for AI assistants

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
- **Global Food Database** (migrations 005/006): ONE shared food table in Supabase (`foods`,
  `food_servings`, `food_aliases`), per 100 g with provenance and a verification status. Every way
  of logging (text, voice, photo, barcode, search) resolves **each item separately**: database →
  product database → AI — `services/meal-analysis.js`. Never call AI for a food the database
  knows; never send the whole meal to AI when one item is unknown. AI only parses text and
  estimates unknown foods; it never writes shared data — `submit_food` validates candidates, and
  an AI food is shared only after two users confirm matching values (or an admin approves).
  Shared tables hold no user data; who submitted what lives in private tables.
- "My foods" = the user's recent items + `favorite_foods`, linked to shared foods by `food_ref`.
  Logged items keep a nutrition snapshot (incl. `micros`), so editing a shared food never
  changes history. Seed data is generated: edit `scripts/food-data/global-foods.mjs`, then
  `USDA_SR_JSON=… npm run build:food-seed` — don't hand-edit 006 or `global-foods.json`.
  `food_key()` (SQL) and `nameKey()` (`lib/food-key.js`) must stay identical (a test checks).
- **Plans & billing** (migration 007): plans/prices/credit costs live in tables (`plans`,
  `plan_prices`, `ai_credit_costs`) — never hard-code a price, limit or plan check; read
  `state.entitlement` (`hasFeature`, `planId`) on the client and `entitlement_for()` /
  `spendCredits()` / `requireFeature()` on the server. Every AI call spends credits via
  `spendCredits` (refunded with `withRefund` if the AI fails). Billing rows are written only by
  the `billing` / `razorpay-webhook` functions (service role) after signature checks; never trust
  the client for a plan. Trial: once per phone and per email (`trial_claims`, hashes only).
  Phone numbers are verified only by Supabase Auth (`profiles_phone_guard`). Admin is a role.
- `supabase/migrations/` schema + RLS; `supabase/functions/` Edge Functions (Deno, TypeScript).

## Guardrails
- **No secrets in the website.** Only the Supabase URL + anon/publishable key go in `js/config.js`.
  Gemini/Claude, Razorpay secret/webhook and WhatsApp keys exist only as Edge Function secrets;
  call AI through `js/services/ai.js` and payments through `js/services/billing.js`.
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
