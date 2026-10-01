# 🥗 NutriLog

A personal nutrition and calorie tracker. Log meals by searching 1,100+ foods (Indian-first), by photo, by barcode or by describing them to AI. Track calories, macros, water, weight and workouts, and see your progress. It works on phones, tablets and desktops, installs as an app (PWA), and syncs across every device you log in to.

- **Frontend:** static HTML/CSS/JS (ES modules, no build step), hosted on GitHub Pages.
- **Backend:** Supabase: Auth, Postgres with Row Level Security, Realtime, and Edge Functions.
- **AI:** Google Gemini and Anthropic Claude, called **only** from Supabase Edge Functions. The browser never sees an API key.

```
Browser (GitHub Pages)  ──  Supabase Auth / Postgres (RLS) / Realtime
        │
        └──►  Supabase Edge Functions  ──►  Gemini / Claude APIs
              (API keys live here, as secrets)
```

---

## Where do my keys go?

| Value | Where it goes | Public? |
|---|---|---|
| **Supabase Project URL** | `js/config.js` → `SUPABASE_URL`, or the GitHub repository variable `SUPABASE_URL` | Yes, designed to be public |
| **Supabase anon / publishable key** | `js/config.js` → `SUPABASE_ANON_KEY`, or the GitHub repository variable `SUPABASE_ANON_KEY` | Yes, designed to be public (RLS protects the data) |
| **Gemini API key** | Supabase Dashboard → **Edge Functions → Secrets** → `GEMINI_API_KEY` | **No, secret** |
| **Claude API key** | Supabase Dashboard → **Edge Functions → Secrets** → `CLAUDE_API_KEY` | **No, secret** |
| Supabase service_role / secret key | Nowhere. Edge Functions get it automatically. | **No, never put it in the website** |
| Database password | Nowhere in this repo | **No** |

Never put the Gemini key, the Claude key, the service_role key or the database password in `index.html`, anything under `js/`, `food_db.js`, `manifest.json`, localStorage, or any file served by GitHub Pages. The app refuses to start if `js/config.js` contains a service-role or secret key.

A template for the secrets lives in `supabase/functions/.env.example`:

```
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
CLAUDE_API_KEY=YOUR_CLAUDE_API_KEY_HERE
```

---

## 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com), or reuse your existing NutriLog project. Old data is preserved, see [Importing data from the old version](#importing-data-from-the-old-version).
2. Open **Project Settings → API** (or **API Keys**) and copy:
   - **Project URL**, for example `https://abcd1234.supabase.co`
   - **anon public** key, or the **publishable** key (`sb_publishable_…`)
3. Put both in `js/config.js`:

   ```js
   export const CONFIG = {
     SUPABASE_URL: 'https://abcd1234.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...',   // anon / publishable key only
     ENABLE_GOOGLE_AUTH: false,
   };
   ```

   If you'd rather not commit them, see [GitHub Pages deployment](#5-github-pages-deployment), option B.

## 2. Supabase database migration

The schema lives in `supabase/migrations/`:

| File | What it does |
|---|---|
| `001_initial_schema.sql` | Creates `profiles`, `user_preferences`, `daily_goals`, `meals`, `meal_items`, `weight_history`, `activities`, `water_logs`, and server-only tables for recovery codes and AI rate limiting. Enables **Row Level Security on every table** with `auth.uid()` policies. Adds the RPCs the app uses and enables Realtime. Renames tables from the previous app version to `legacy_*` without deleting anything. |
| `002_legacy_import.sql` | Functions that move data from the previous version into the new tables. |

Run them with either method.

**A. Supabase CLI (recommended)**
```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF    # the "abcd1234" part of your URL
supabase db push
```

**B. Dashboard:** open **SQL Editor**, then paste and run `001_initial_schema.sql`, then `002_legacy_import.sql`.

After either method, **Table Editor** should show a shield (RLS enabled) on every table.

## 3. Supabase Auth setup

In the Supabase Dashboard:

1. **Authentication → Sign In / Providers → Email**: keep it enabled. Turning on **Confirm email** is recommended; the app shows a "check your email" screen.
2. **Authentication → URL Configuration**:
   - **Site URL:** `https://YOUR_USERNAME.github.io/NutriLog/`
   - **Redirect URLs:** add `https://YOUR_USERNAME.github.io/NutriLog/` and, for local testing, `http://localhost:8080/`.
   These are used by confirmation, magic-link and password-reset emails.
3. **Authentication → Emails → SMTP settings**: Supabase's built-in email service only sends a few emails per hour. For real users, configure your own SMTP, for example Resend, Postmark or SES.
4. **Authentication → Policies / Passwords**: minimum length 8 matches the app. Enable leaked-password protection if your plan has it.
5. **Anonymous sign-ins**: the new app doesn't use them. If the old version was used in "Secure Mode", leave them on until those devices have created accounts, then turn them off.
6. **Optional, Google sign-in**: enable **Google** under Providers with your Google OAuth client, add the Supabase callback URL to Google, then set `ENABLE_GOOGLE_AUTH: true` in `js/config.js`.

## 4. Edge Functions

| Function | Purpose | Auth |
|---|---|---|
| `ai-food-analysis` | Food text → items; food photo → items; activity text → activities | Signed-in user, rate limited |
| `ai-chat` | Nutri AI coach: chat, "review my day", "suggest what to eat" | Signed-in user, rate limited |
| `account-recovery` | Create a recovery code (signed in); reset password with email + code (signed out) | Mixed, attempt-limited |
| `delete-account` | Permanently deletes the user and all their data | Signed-in user |

Deploy them:

```bash
supabase functions deploy ai-food-analysis
supabase functions deploy ai-chat
supabase functions deploy account-recovery
supabase functions deploy delete-account
```

`supabase/config.toml` sets `verify_jwt = false` for these functions because each one verifies the caller's session itself, which works with both old and new Supabase JWT keys. If you deploy another way, add `--no-verify-jwt`.

The AI functions compute every total themselves from per-100 g values (`total = per100 × grams ÷ 100`), check calories against macros, and clamp impossible values. Arithmetic mistakes by the model can't reach your log. Users always review AI results before saving.

## 5. Secret configuration (API keys)

**Where I put my Gemini API key:** Supabase Dashboard → **Edge Functions → Secrets** → add `GEMINI_API_KEY`.

**Where I put my Claude API key:** Supabase Dashboard → **Edge Functions → Secrets** → add `CLAUDE_API_KEY`.

Or from the CLI:

```bash
cp supabase/functions/.env.example supabase/functions/.env   # git-ignored
# edit supabase/functions/.env and paste your real keys
supabase secrets set --env-file supabase/functions/.env
```

Optional secrets, with defaults shown in `.env.example`:

| Secret | Default | Meaning |
|---|---|---|
| `AI_FOOD_PROVIDER` | `gemini` | Provider for food/photo/activity analysis; the other one is the fallback |
| `AI_CHAT_PROVIDER` | `claude` | Provider for the coach |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash` / `gemini-3.1-flash-lite` | Gemini models |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model |
| `AI_HOURLY_LIMIT` / `AI_DAILY_LIMIT` | `30` / `150` | AI requests per user |
| `ALLOWED_ORIGINS` | any | Set to `https://YOUR_USERNAME.github.io` to restrict CORS |

You only need one of the two AI keys. With just one, both features use it. With neither, AI buttons show "AI features are not available yet" and everything else works.

## 6. GitHub Pages deployment

All paths are relative and routing uses the URL hash (`#/dashboard`), so the site works at `https://YOUR_USERNAME.github.io/NutriLog/` and direct links never 404.

**Option A: deploy from the branch (simplest)**
1. Put your public URL and anon key in `js/config.js` and commit.
2. Repository → **Settings → Pages → Source: Deploy from a branch** → `main` / root.
3. When you change the app, bump `VERSION` in `sw.js` so installed copies update.

**Option B: GitHub Actions (keys not committed, tests run first)**
1. Repository → **Settings → Secrets and variables → Actions → Variables**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Add `ENABLE_GOOGLE_AUTH=true` if you use Google. These are public values, so *Variables* is fine.
2. **Settings → Pages → Source: GitHub Actions.**
3. Push to `main`. `.github/workflows/deploy.yml` runs lint and tests, writes `js/config.js` from the variables, stamps the service-worker version with the commit, and deploys.

## 7. Local development

```bash
npm install          # dev tools only: tests, lint, PGlite, Playwright
npm run serve        # http://localhost:8080  (or any static server)
```

Add `http://localhost:8080/` to Supabase's redirect URLs to test email links locally.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (nutrition math, food search, food database, stats, PWA, secrets scan) and database tests: runs the real migrations on an in-process Postgres (PGlite) and checks RLS isolation between users |
| `npm run test:e2e` | Browser tests with Playwright against a mocked Supabase: signup → onboarding → logging → offline sync → second device → recovery → account deletion. First run `npx playwright install chromium` |
| `npm run test:functions` / `npm run check:functions` | Deno tests and type-check for the Edge Functions |
| `npm run lint` | ESLint |
| `npm run build:foods` | Rebuilds `food_db.js` from `scripts/food-data/` and writes `scripts/food-data/CORRECTIONS.md` |
| `npm run build:icons` | Renders PNG icons from `icons/*.svg` |

---

## Importing data from the old version

The previous NutriLog stored data in `meals`, `user_settings`, `activities` and `weight_logs` with a text `user_id`. The migration renames these to `legacy_*` and keeps them.

- **Devices that used "Secure Mode"** (anonymous sign-in): open the new app on that device and choose **Create account**. The anonymous user is upgraded to a real account with the same id. The app then imports meals, weigh-ins, activities, goals and body stats automatically, along with weigh-ins that were only in that browser.
- **Devices that used legacy mode** (a random device id): find the old id. The new app saves it in that browser as `localStorage["nutrilog.legacyDeviceId"]`; open DevTools → Application → Local Storage. Create your new account, find its user id under **Authentication → Users**, then run in the **SQL Editor**:

  ```sql
  select public.admin_import_legacy_user('<old device id>', '<new auth user id>', 'Asia/Kolkata');
  ```

  This function can only be run by the project owner. Signed-in users cannot call it.

Imports are idempotent, so running them twice never duplicates rows. The old app had no meal types, so each entry gets breakfast, lunch, snack or dinner based on the time it was logged.

## Security model

- **Real accounts.** Supabase Auth with email + password, magic link, password reset, optional Google, and optional single-use **recovery codes** (`NUTRI-XXXX-XXXX`). Recovery codes are stored only as bcrypt hashes, limited to 5 attempts per email per hour, and never reveal whether an email exists. Name, age and height are profile data only and are never used to access an account.
- **Row Level Security** on every table: `auth.uid() = user_id`. The anon role can't read any user data. Server-only tables (recovery codes, AI usage) aren't reachable from the browser at all. The test suite verifies this against the real migration SQL.
- **No secrets in the browser.** AI keys exist only as Edge Function secrets. The old app's keys stored in `localStorage` (`geminiKey`, `claudeKey`, `supaUrl`, `supaKey`) are deleted the first time the new app loads.
- **XSS:** all dynamic HTML goes through an escaping `html` template tag; there are no inline event handlers, and a Content-Security-Policy restricts scripts to this site and jsDelivr. The barcode library is loaded with Subresource Integrity.
- **Abuse limits:** per-user AI quotas (atomic, in Postgres), input size limits, and an image size cap.
- **Service worker:** caches only the app shell and public libraries. It never caches Supabase, Edge Function or Open Food Facts responses.
- If you use a **custom Supabase domain**, add it to `connect-src` in the CSP `<meta>` tag in `index.html`.

## Nutrition data and calculations

- **Food database** (`food_db.js`, 1,111 foods): 109 curated staples with reference values (USDA / IFCT) and household portions such as "1 medium roti (40 g)" and "1 katori dal (150 g)", plus 1,002 Indian recipes. Every food uses one model: `{ id, name, category, servingSize: 100, servingUnit, calories, protein, carbs, fat, fiber, portions }`. Nutrition for any amount is `value × grams ÷ 100`, stored unrounded and rounded only for display.
- **Corrections to the old data:** 124 fried dishes counted the whole frying-oil vat (Poori was 738 kcal / 100 g). 29 soups had macros several times larger than their calories. A 45 kcal "boiled egg" and other dry-basis entries were wrong. Every change is listed in `scripts/food-data/CORRECTIONS.md`, and tests fail if calories and macros disagree for any food.
- **Targets:** BMR uses Mifflin–St Jeor. TDEE is BMR × an activity multiplier (1.2–1.9). Weight loss uses −500 kcal, never more than 20% of TDEE and never below 1,200 (women) or 1,500 (men). Gain uses +10%; muscle gain uses +5%. Protein is 1.4–2.0 g/kg by goal, using an adjusted weight above BMI 25. Fat is a share of calories, carbs fill the rest, and fiber is 14 g per 1,000 kcal. The app shows every step. Custom targets are never overwritten.
- **Exercise** uses net MET calories, `(MET − 1) × kg × hours`, and is either already covered by your activity level (default) or added to your daily budget. It is never counted twice.

Nutrition values are estimates for guidance, not medical advice.

## Project structure

```
index.html              App shell (CSP, theme bootstrap, fonts)
css/app.css             Design tokens (light/dark) and components
js/config.js            PUBLIC config: Supabase URL + anon key
js/theme-init.js        Applies the saved theme before first paint
js/app.js               Auth-gated routing, app shell, sync and realtime wiring
js/router.js, store.js  Hash router, state + event bus
js/lib/                 Pure logic: nutrition, food search, stats, activity, utils
js/services/            Supabase client, auth, data (offline queue), foods, AI, reminders
js/ui/                  DOM helpers, charts (SVG), icons, theme
js/views/               Auth, onboarding, dashboard, food logger, calories, progress, settings, chat
food_db.js              Generated food database
sw.js, manifest.json    PWA
supabase/migrations/    Database schema + RLS
supabase/functions/     Edge Functions (Deno) + shared helpers
scripts/                Food database and icon build scripts
tests/                  unit/, db/ (PGlite), e2e/ (Playwright + mock Supabase)
```
