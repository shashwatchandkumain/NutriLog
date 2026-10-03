# 🥗 NutriLog

A personal nutrition and calorie tracker. Describe a meal or snap a photo and AI (Gemini or Claude, your choice) works out the nutrition; re-log your own recent and favorite foods in one tap; scan barcodes; measure your weight, heart rate and body composition with a Bluetooth smart scale; set a target weight and date and get calories planned to reach it. Track calories, macros, water, weight and workouts, and see your progress. It works on phones, tablets and desktops, installs as an app (PWA), and syncs across every device you log in to.

- **Frontend:** static HTML/CSS/JS (ES modules, no build step), hosted on GitHub Pages.
- **Backend:** Supabase: Auth, Postgres with Row Level Security, Realtime, and Edge Functions.
- **AI:** Google Gemini and Anthropic Claude, called **only** from Supabase Edge Functions. The browser never sees an API key.
- **Smart scale:** the Cult Smart Scale over Web Bluetooth, straight from the browser — no extra app, server or database.

```
Smart scale ──Bluetooth──► Browser (GitHub Pages)  ──  Supabase Auth / Postgres (RLS) / Realtime
                                   │
                                   └──►  Supabase Edge Functions  ──►  Gemini / Claude APIs
                                         (API keys live here, as secrets)
```

## Using NutriLog

| Screen | What's there |
|---|---|
| **Dashboard** | Calories consumed / remaining / target, macros with % of target, quick actions (log food, AI food scan, barcode, measure weight, add water, log activity), today's meals, water, weight, activity, daily score, last 7 days |
| **Food** | Every way to log food, the day's meals (edit, duplicate, delete, copy to today, repeat yesterday's meal), nutrition vs. targets, and **Quick add** from your own foods |
| **Progress** | Goal progress, weight trend with a 7-day average, calories, protein, body composition, weekly averages, logging streak — 7D / 30D / 90D / 1Y / All |
| **Measure** | Cult Smart Scale weigh-ins, manual entry, the latest result with its estimates explained, weigh-in history |
| **More** | Activity & calories, the Nutri AI coach, calendar, "How your target is calculated", settings, Bluetooth help, log out |

On phones these are the bottom tabs; on desktop they're in the sidebar. **Log food** is always one tap away (the + button on phones, the sidebar button on desktop).

**Logging food:** type, say (🎤 Voice) or photograph what you ate, scan a barcode, or search. Every food is looked up in NutriLog's shared **Global Food Database** first — known foods are calculated instantly on your device, with no AI call. Only foods the database doesn't know yet are estimated by AI, one item at a time (in "2 roti, 4 boiled eggs and homemade peanut chutney", only the chutney goes to AI). You review every item before it's saved: each one shows whether it came from the database or is an AI estimate, its amount (servings like "1 large egg", fractions, or grams) and its nutrition. **My foods** finds the foods you've logged or starred and the shared database.

## Plans, AI credits and the free trial

| | Free | Pro | Pro AI |
|---|---|---|---|
| Price (+ 18% GST) | ₹0 | ~~₹299~~ **₹149**/month · ~~₹3,588~~ **₹999**/year | ~~₹600~~ **₹299**/month · ~~₹7,200~~ **₹1,999**/year |
| AI credits a month | 20 | 150 | 600 |
| Everything else in the app (database foods, My foods, barcodes, voice, water, weight, smart scale) | ✅ | ✅ | ✅ |
| Progress history | 30 days | all | all |
| Weekly AI report · vitamins & minerals · body-composition history | — | ✅ | ✅ |
| AI meal plan + grocery list · choosing Claude | — | — | ✅ |

- **AI credits** are only spent when AI actually runs: a meal with foods the database doesn't know (1–2), a photo (5), a coach message (1), a weekly report (10), a meal plan (5 for a day, 10 for a week). Foods from the NutriLog database, My foods, barcodes and manual entries are free. Credits refill on the 1st of each month (IST). Costs are in `public.ai_credit_costs`.
- **Exclusive offer — one week of Pro AI free.** The user sets up UPI autopay or a card with Razorpay (₹0 today; the bank may show a small reversed authorisation). After 7 days Pro AI monthly is charged unless they cancel in Settings → Plan & billing (cancelling during the trial charges nothing and keeps Pro AI until it ends). **One trial per phone number and per email, ever** — the ledger keeps only hashes and survives account deletion.
- **Prices live in the database** (`public.plan_prices`, in paise, before GST; `list_paise` is the crossed-out price). After changing a price, open **Admin → Set up Razorpay plans** so Razorpay has a plan with the new amount; existing subscribers keep their old plan.
- **Phone numbers** are every account's primary contact (email is the backup). Log in with phone or email + password once the phone is verified.
- **Admin** is a role (`public.app_admins`), not a plan. Admins see **More → Admin**: users by plan, monthly revenue, payment events, search users by phone/email, give someone a plan for 30 days or add credits, plus the food-database tools.

### Turning on payments (Razorpay)

1. Create a Razorpay account (test mode works at once; live mode needs business KYC). **Settings → API Keys → Generate** (test).
2. Add the keys as Edge Function secrets (never in the website):
   ```bash
   npx supabase secrets set RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... --project-ref YOUR_REF
   ```
3. **Settings → Webhooks → Add**: URL `https://YOUR_REF.supabase.co/functions/v1/razorpay-webhook`, a secret of your choice, events `subscription.*`. Then `npx supabase secrets set RAZORPAY_WEBHOOK_SECRET=that-secret`.
4. In NutriLog (as admin): **More → Admin → Set up Razorpay plans** — creates the four plans with GST included.
5. Test with Razorpay's test cards / UPI (`success@razorpay`). To go live: repeat 1–4 with the live keys.

Charging GST requires a GSTIN. If you aren't GST-registered yet, set `gst_rate` to 0 in `public.plan_prices` (then run step 4 again).

### Turning on phone verification (WhatsApp)

1. In Meta Business: create a WhatsApp Business app, add a phone number that is **not** on the WhatsApp app, and create an **Authentication** template named `nutrilog_otp` with a **Copy code** button. Create a System User token with `whatsapp_business_messaging` permission.
2. Secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (and `WHATSAPP_TEMPLATE` / `WHATSAPP_TEMPLATE_LANG` if different).
3. Supabase Dashboard → **Authentication → Sign In / Providers → Phone**: enable, confirmations on. **Authentication → Hooks → Send SMS hook**: HTTPS, URL `https://YOUR_REF.supabase.co/functions/v1/send-otp`; copy the generated secret into `SEND_SMS_HOOK_SECRETS`. (Or set `[auth.hook.send_sms] enabled = true` in `supabase/config.toml` and `npx supabase config push`.)
4. `npx supabase secrets set PHONE_VERIFICATION=on` — from then on, accounts verify their number with a WhatsApp code, the trial requires a verified number, and phone + password login works. Until then numbers are saved but not verified.

## Global Food Database

One shared food database in Supabase, used by every NutriLog user, that grows as people use the app.

- **What's in a food:** nutrition per 100 g (calories, protein, carbs, fat, fiber, sugar, saturated and trans fat, sodium, cholesterol, vitamins and minerals — unknown values stay empty, never zero), servings ("1 large egg = 50 g", "1 katori = 150 g"), other names people use ("anda", "chapati"), preparation, and its source.
- **Starting data:** 111 common and Indian foods — 71 from USDA FoodData Central (public domain, with vitamins and minerals) and 40 Indian dishes from NutriLog's reference table (IFCT 2017 / USDA). Generated by `npm run build:food-seed` from `scripts/food-data/global-foods.mjs`.
- **How it grows:** when AI estimates a new food and you confirm it, it's saved as a *candidate* that only you see. When a second user confirms matching values (within 15 %), it's shared with everyone — from then on nobody needs AI for it. If users disagree, it waits for an admin. Scanned products are shared from their label data right away. Names you use for a known food ("ubla anda" → Boiled egg) become shared once two users use them. Personal recipes ("my mom's curry") are never shared.
- **Corrections:** users can't edit shared foods. "Wrong values?" sends a report; an admin applies or dismisses it. Logged meals keep the values they were saved with.
- **Privacy:** shared tables contain only food information — never names, emails, meals or photos. Who confirmed or reported what is stored privately.
- **Admin:** accounts listed in `public.app_admins` see **More → Food database (admin)**: database vs AI usage ("AI calls avoided"), new foods to approve, reject or merge, correction reports and suggested names. Add an admin in the SQL editor: `insert into public.app_admins select id from auth.users where email = 'you@example.com';`
- **Saving AI cost:** typical meals of known foods make **zero** AI calls; free-form text costs one small "parse" call; only unknown foods need an "estimate" call (with a much smaller prompt than before).

---

## Where do my keys go?

| Value | Where it goes | Public? |
|---|---|---|
| **Supabase Project URL** | `js/config.js` → `SUPABASE_URL`, or the GitHub repository variable `SUPABASE_URL` | Yes, designed to be public |
| **Supabase anon / publishable key** | `js/config.js` → `SUPABASE_ANON_KEY`, or the GitHub repository variable `SUPABASE_ANON_KEY` | Yes, designed to be public (RLS protects the data) |
| **Gemini API key** | Supabase Dashboard → **Edge Functions → Secrets** → `GEMINI_API_KEY` | **No, secret** |
| **Claude API key** | Supabase Dashboard → **Edge Functions → Secrets** → `CLAUDE_API_KEY` | **No, secret** |
| Razorpay Key ID | Edge Function secret `RAZORPAY_KEY_ID` (the app receives it from the billing function) | Yes (it's shown to Checkout) |
| Razorpay Key Secret / Webhook secret | Edge Function secrets `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | **No, secret** |
| WhatsApp (Meta) token, Supabase hook secret | Edge Function secrets `WHATSAPP_TOKEN`, `SEND_SMS_HOOK_SECRETS` | **No, secret** |
| Supabase service_role / secret key | Nowhere. Edge Functions get it automatically. | **No, never put it in the website** |
| Database password | Nowhere in this repo | **No** |

Never put the Gemini key, the Claude key, the service_role key or the database password in `index.html`, anything under `js/`, `manifest.json`, localStorage, or any file served by GitHub Pages. The app refuses to start if `js/config.js` contains a service-role or secret key, and a test scans every website file for API keys.

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

   If you'd rather not commit them, see [GitHub Pages deployment](#6-github-pages-deployment), option B.

## 2. Supabase database migration

The schema lives in `supabase/migrations/`:

| File | What it does |
|---|---|
| `001_initial_schema.sql` | Creates `profiles`, `user_preferences`, `daily_goals`, `meals`, `meal_items`, `weight_history`, `activities`, `water_logs`, and server-only tables for recovery codes and AI rate limiting. Enables **Row Level Security on every table** with `auth.uid()` policies. Adds the RPCs the app uses and enables Realtime. Renames tables from the previous app version to `legacy_*` without deleting anything. |
| `002_legacy_import.sql` | Functions that move data from the previous version into the new tables. |
| `003_scale_goals_ai.sql` | Weights to 0.01 kg, plus each weigh-in's source, heart rate and body-composition snapshot; the profile's **target date**; activity **MET** values with calories computed in the database from your weight on that day (and recomputed whenever weigh-ins change); the **AI model** preference. |
| `004_water_ml_favorites.sql` | Water in **millilitres** (and the water goal in ml), kept in sync with the old glasses columns by triggers so an older app version still works; the **favorite foods** table (private to each user by RLS); logged foods can be renamed. |
| `005_global_foods.sql` | The shared **Global Food Database**: foods, servings, aliases, private submissions/corrections, resolution statistics, admins; matching, search, candidate validation and promotion, alias voting, admin functions; logged items link to shared foods and keep a nutrition snapshot. |
| `006_global_foods_seed.sql` | The starting foods (generated — see Global Food Database). |
| `007_subscriptions.sql` | Plans, prices, AI credits, Razorpay subscriptions, admin-given plans, the one-trial-per-phone/email ledger, phone numbers on profiles (verified only by Supabase Auth), saved AI reports and meal plans, admin tools. |

Run them with either method.

**A. One command (recommended)** — logs in, applies the migrations, uploads the AI keys from `supabase/functions/.env` and deploys the Edge Functions:
```bash
npm run setup:supabase
```

**B. Supabase CLI by hand**
```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF    # the "abcd1234" part of your URL
npx supabase db push
```

**C. Dashboard:** open **SQL Editor**, then paste and run each file in order.

After any method, **Table Editor** should show a shield (RLS enabled) on every table.

**Updating an existing deployment:** after pulling new code, run `npx supabase db push` (new migrations) and redeploy the Edge Functions (step 4) *before* the new website goes live — the website expects the latest schema. Both are safe to repeat.

## 3. Supabase Auth setup

In the Supabase Dashboard:

1. **Authentication → Sign In / Providers → Email**: keep it enabled. Turning on **Confirm email** is recommended; the app shows a "check your email" screen.
2. **Authentication → URL Configuration** (also in `supabase/config.toml`, pushed with `npx supabase config push`):
   - **Site URL:** `https://YOUR_USERNAME.github.io/NutriLog/`
   - **Redirect URLs:** add `https://YOUR_USERNAME.github.io/NutriLog/` and, for local testing, `http://localhost:8080/`.
   These are used by confirmation, magic-link and password-reset emails. If the Site URL is still `http://localhost:3000`, confirmation links open a broken page.
3. **Authentication → Emails → SMTP settings**: Supabase's built-in email service only sends a few emails per hour. For real users, configure your own SMTP, for example Resend, Postmark or SES.
4. **Authentication → Policies / Passwords**: minimum length 8 matches the app. Enable leaked-password protection if your plan has it.
5. **Anonymous sign-ins**: the app doesn't use them. If the old version was used in "Secure Mode", leave them on until those devices have created accounts, then turn them off.
6. **Optional, Google sign-in**: enable **Google** under Providers with your Google OAuth client, add the Supabase callback URL to Google, then set `ENABLE_GOOGLE_AUTH: true` in `js/config.js`.

## 4. Edge Functions

| Function | Purpose | Auth |
|---|---|---|
| `ai-food-analysis` | Food text → items; food photo → items; activity text → activities with MET values | Signed-in user, rate limited |
| `ai-chat` | Nutri AI coach: chat, "review my day", "suggest what to eat" | Signed-in user, rate limited |
| `account-recovery` | Create a recovery code (signed in); reset password with email + code (signed out) | Mixed, attempt-limited |
| `delete-account` | Cancels any running subscription, then permanently deletes the user and all their data | Signed-in user |
| `billing` | Plans and prices, starting a subscription or the free trial, verifying Razorpay payments, cancelling, creating the Razorpay plans (admin) | Signed-in user |
| `razorpay-webhook` | Razorpay → NutriLog payment events (renewals, failed payments, cancellations) | Razorpay HMAC signature |
| `send-otp` | Supabase Auth "Send SMS" hook → sends phone verification codes on WhatsApp | Supabase hook signature |

Deploy them:

```bash
npx supabase functions deploy ai-food-analysis --use-api
npx supabase functions deploy ai-chat --use-api
npx supabase functions deploy account-recovery --use-api
npx supabase functions deploy delete-account --use-api
npx supabase functions deploy billing --use-api
npx supabase functions deploy razorpay-webhook --use-api
npx supabase functions deploy send-otp --use-api
```

`supabase/config.toml` sets `verify_jwt = false` for these functions because each one verifies the caller's session itself, which works with both old and new Supabase JWT keys. If you deploy another way, add `--no-verify-jwt`.

**How AI estimates are kept accurate and consistent between Gemini and Claude:** both models get the same estimation protocol (most-likely values, explicit home-style vs. restaurant cooking-oil amounts, cooked weights, household portions) and the same reference table of 109 staple foods (`supabase/functions/_shared/reference-foods.ts`, USDA / IFCT values). The models only estimate macros per 100 g and the portion weight; the server computes energy from the macros (4·protein + 4·carbs + 9·fat + 7·alcohol) and every total as `per100 × grams ÷ 100`. So one model's habit of guessing calories low or high can't reach your log. Users always review AI results before saving, and the review shows which model answered.

## 5. Secret configuration (API keys)

**Where I put my Gemini API key:** Supabase Dashboard → **Edge Functions → Secrets** → add `GEMINI_API_KEY`.

**Where I put my Claude API key:** Supabase Dashboard → **Edge Functions → Secrets** → add `CLAUDE_API_KEY`.

Or from the CLI:

```bash
cp supabase/functions/.env.example supabase/functions/.env   # git-ignored
# edit supabase/functions/.env and paste your real keys
npx supabase secrets set --env-file supabase/functions/.env
```

Optional secrets, with defaults shown in `.env.example`:

| Secret | Default | Meaning |
|---|---|---|
| `AI_FOOD_PROVIDER` / `AI_CHAT_PROVIDER` | `gemini` / `claude` | Used only when a request doesn't say which model; users choose in **Settings → AI model** |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash` / `gemini-3.5-flash-lite` | Gemini models; the lighter one answers when the main one is busy |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model |
| `AI_HOURLY_LIMIT` / `AI_DAILY_LIMIT` | `30` / `150` | AI requests per user |
| `ALLOWED_ORIGINS` | `https://shashwatchandkumain.github.io` | Sites allowed to call the functions from a browser (comma-separated). Set it to your own GitHub Pages origin if you fork NutriLog; add `http://localhost:8080` for local development. Never `*`. |

You only need one of the two AI keys. With just one, every feature uses it. If the chosen model fails, the other one answers. With neither, AI buttons show "AI features are not available yet" and everything else works.

**Gemini free tier:** Google's free tier allows only about 20 requests a day for `gemini-3.5-flash` (per project; check yours at [ai.dev/rate-limit](https://ai.dev/rate-limit)). When it runs out — or the model is overloaded — NutriLog switches to `gemini-3.5-flash-lite` within seconds, so logging keeps working. For heavier use, enable billing on the Google AI Studio project, or set `GEMINI_MODEL=gemini-3.5-flash-lite`.

## 6. GitHub Pages deployment

All paths are relative and routing uses the URL hash (`#/dashboard`), so the site works at `https://YOUR_USERNAME.github.io/NutriLog/` and direct links never 404.

**Option A: GitHub Actions (recommended — tests run first)**
1. **Settings → Pages → Source: GitHub Actions.**
2. Either commit `js/config.js` with your public URL and anon key, or add them as repository **Variables** (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, optional `ENABLE_GOOGLE_AUTH=true`) under **Settings → Secrets and variables → Actions**. These are public values, so *Variables* is fine.
3. Push to `main`. `.github/workflows/deploy.yml` runs lint, the tests and the build check, writes `js/config.js` from the variables if they are set, builds `_site/` with the service-worker version set to the commit, and deploys it.

**Option B: deploy from the branch**
1. Put your public URL and anon key in `js/config.js` and commit.
2. **Settings → Pages → Source: Deploy from a branch** → `main` / root.
3. When you change the app, bump `VERSION` in `sw.js` so installed copies update, and run `npm run build -- --check` before pushing.

**Updates:** when a new version is deployed, open copies of the app show "A new version of NutriLog is available" with an **Update** button, which reloads into the new version. Nothing waiting to sync is lost: changes are saved on the device until the server confirms them.

**Build check:** `npm run build` assembles `_site/` and fails if a file in the service worker's app shell is missing (or a JS file isn't in it), an import or asset path is broken or root-absolute (which breaks under `/NutriLog/`), a module is loaded from a host the Content-Security-Policy doesn't allow, or anything that looks like a secret key would be published.

## 7. Local development

```bash
npm install          # dev tools only: tests, lint, PGlite, Playwright
npm run serve        # http://localhost:8080  (or any static server)
```

Add `http://localhost:8080/` to Supabase's redirect URLs to test email links locally. Web Bluetooth works on `localhost` too.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (nutrition and goal-date math, smart-scale protocol, body composition, activity calories, your-foods search, import formats, stats, PWA, build check, secrets scan) and database tests: runs the real migrations on an in-process Postgres (PGlite) and checks RLS isolation, the activity-calorie triggers and the water ml/glasses sync |
| `npm run test:e2e` | Browser tests with Playwright against a mocked Supabase and a simulated Bluetooth scale: signup → onboarding with a target date → AI logging → edit → water → smart-scale weigh-in (and a failed connection) → targets update → progress → activity → favorites and one-tap re-log → duplicate / undo / repeat yesterday → offline sync → a rejected change kept and retried → second device → no horizontal scrolling at 10 widths from 320 to 1440 px → export → delete my data → recovery → account deletion → a new version installs and "Update" reloads into it → "Today" follows midnight. First run `npx playwright install chromium`; set `E2E_SCREENSHOTS=<folder>` to save screenshots |
| `npm run build` | Checks the site and assembles `_site/` for GitHub Pages (`-- --check` to only check) |
| `npm run test:functions` | Deno tests: AI rules, hedging, Razorpay payment and webhook signatures (vectors computed independently), webhook idempotency, the WhatsApp hook signature, weekly-report and meal-plan maths |
| `npm run build:food-seed` | Regenerates the starting Global Food Database from `scripts/food-data/global-foods.mjs` (needs `USDA_SR_JSON` pointing at USDA's SR Legacy JSON download) |
| `npm run test:functions` / `npm run check:functions` | Deno tests and type-check for the Edge Functions |
| `npm run lint` | ESLint |
| `npm run setup:supabase` | Applies migrations, uploads secrets and deploys Edge Functions to your project |
| `npm run build:icons` | Renders PNG icons from `icons/*.svg` |

---

## Smart scale

NutriLog reads the **Cult Smart Scale** (CS-BF01) over Bluetooth directly from the browser.

- **Where it works:** Chrome or Edge on Android, Windows, macOS, ChromeOS and Linux (with Bluetooth on), over HTTPS. Safari on iPhone/iPad doesn't support Web Bluetooth — use the free **Bluefy** browser there, or enter your weight manually.
- **How:** open **Measure** (bottom tab or sidebar) or tap **Measure weight** on the dashboard, step on the scale to wake it, tap **Connect**, pick **Cult Smart Scale** in the list and stand still. The app shows each step (searching, scale found, connecting, step on the scale, hold still, reading measurement, complete). The weight locks after three identical readings, then the scale reads your heart rate. Tap **Log this** to save — one weigh-in per day; logging again the same day replaces it. If it can't connect, you get a plain-English reason with **Try again**, **Bluetooth help** and **Enter manually**.
- **What you get:** weight to 0.01 kg and heart rate from the scale; BMI, body fat %, fat mass, lean mass, body water and BMR estimated from your weight, height, age and sex (Deurenberg, Watson and Mifflin–St Jeor equations). This scale doesn't expose a usable impedance over Bluetooth, so body composition is a trend estimate, not a lab measurement.
- **What happens next:** automatic (non-custom) calorie and macro targets update to the new weight, and exercise calories for that day are recalculated for it.

The frame format and weigh-in logic are in `js/lib/scale-protocol.js` (unit-tested with captured frames); the browser connection is `js/services/scale.js`.

## Import a profile

**Settings → Your data → Import a profile** accepts:

- a **NutriLog export** (Settings → Export → JSON) from this or another person's account — pick weigh-ins, food log, activities, water, and optionally profile details and targets;
- a **smart-scale backup** (the occult app's JSON export) with one or more household profiles — pick a profile; its daily weigh-ins (with heart rate) are added, and optionally its sex, age and height.

Imports are additive: days that already have a weigh-in or water entry are kept, and importing the same file twice never creates duplicates (rows get deterministic ids).

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
- **Bluetooth:** the browser asks before connecting to any device; readings go only from the scale to your account.
- **CORS:** the Edge Functions only answer browsers on NutriLog's own site (`ALLOWED_ORIGINS`), never `*`.
- **Service worker:** caches only the app shell and public libraries. It never caches Supabase, Edge Function or Open Food Facts responses.
- If you use a **custom Supabase domain**, add it to `connect-src` in the CSP `<meta>` tag in `index.html`.

## Nutrition data and calculations

- **Food logging is AI-first.** Describe the meal ("2 roti, 1 katori dal tadka, chai with sugar") or snap a photo; the review screen lets you correct every name, portion and value before saving. Foods you've logged or starred can be searched and re-logged in one tap (nutrition scales linearly with the amount). Packaged foods can be scanned (Open Food Facts), and anything can be entered manually. Nutrition for any amount is `per-100 g value × grams ÷ 100`, stored unrounded and rounded only for display.
- **Water** is logged in millilitres (+250 / +500 / +750 ml / +1 L or any amount) against a daily goal in ml (Settings → Nutrition & goals).
- **Targets:** BMR uses Mifflin–St Jeor. TDEE is BMR × an activity multiplier (1.2–1.9). With a **target weight and date**, the daily deficit or surplus is `(target − current) kg × 7,700 kcal ÷ days left`, so you reach the target on that day — capped at a safe pace (losing: 1% of body weight a week, max 1 kg; gaining: 0.5 kg; muscle: 0.25 kg) and never below 1,200 (women) / 1,500 (men) kcal. Without a date, losing uses −500 kcal (never more than 20% of TDEE), gaining +10%, muscle +5%. Protein is 1.4–2.0 g/kg by goal, using an adjusted weight above BMI 25; fat is a share of calories, carbs fill the rest, and fiber is 14 g per 1,000 kcal. Targets are exact (whole kcal, 0.1 g) — never rounded to "nice" numbers — and the app shows every step.
- **Automatic vs. custom:** automatic targets follow your latest weigh-in, profile and goal date. Custom targets are never overwritten.
- **Exercise** uses net MET calories, `(MET − 1) × your weight on that day × hours`, to 0.01 kcal. Treadmill sessions use the ACSM walking/running equations for your speed and incline. Calories are computed in the database from your weigh-ins, so a new weigh-in updates them on every device. Exercise is either already covered by your activity level (default) or added to your daily budget — never counted twice.

Nutrition values are estimates for guidance, not medical advice.

## Your data

**Settings → Your data**: export everything as JSON (or the food log as CSV), import a profile, or **Delete my data** — erases all meals, weigh-ins, activities, water and favorites on every device while keeping the account, profile and targets. **Delete my account** (Settings → Account) removes everything.

If the server ever rejects a change (for example invalid data), it isn't dropped: the sync status shows "1 not saved", and tapping it lets you try again or discard it.

## Project structure

```
index.html              App shell (CSP, theme bootstrap, fonts)
css/app.css             Design tokens (light/dark) and components
js/config.js            PUBLIC config: Supabase URL + anon key
js/theme-init.js        Applies the saved theme before first paint
js/app.js               Auth-gated routing, app shell, sync, realtime and automatic targets
js/router.js, store.js  Hash router, state + event bus
js/lib/                 Pure logic: nutrition + goal plans, body composition, scale protocol,
                        activity, import formats, stats, utils
js/services/            Supabase client, auth, data (offline queue), Bluetooth scale, barcode, AI, reminders
js/ui/                  DOM helpers, charts (SVG), icons, theme
js/views/               Auth, onboarding, dashboard, food (page, logger, meals), measure + weigh-in
                        (scale), progress, activity, more, settings, targets explainer, import, chat;
                        lazy.js loads the less-used screens on demand
sw.js, manifest.json    PWA
supabase/migrations/    Database schema + RLS
supabase/functions/     Edge Functions (Deno) + shared helpers and the AI reference table
scripts/                Build check (build.mjs), backend setup and icon build scripts
tests/                  unit/, db/ (PGlite), e2e/ (Playwright + mock Supabase + simulated scale)
```
