# 🥗 NutriLog — AI Diet Tracker

A fast, installable (PWA) diet and nutrition tracker. Log meals by typing, by photo, or by
barcode; track calories and macros; monitor weight and activity; and chat with an AI nutrition
coach. Works on mobile and desktop, online and offline.

Everything runs in a single `index.html` (no build step). Data syncs to your own free Supabase
project; AI runs on your own free Google Gemini key (Claude optional).

## Features

- **AI food logging** — describe a meal in plain language and get instant calories + macros.
- **Photo & barcode logging** — snap a plate, or scan a packaged-food barcode (OpenFoodFacts).
- **Built-in Indian food database** — 1,000+ items for instant, offline, no-AI quick-add.
- **Macros & health score** — calories, protein, carbs, fat, fiber, with a daily health score.
- **Charts** — weekly calories, monthly report, calendar heatmap, weight & trend lines.
- **Weight & activity** — log weight; log exercise with MET-based calorie-burn estimates.
- **TDEE / net calories** — BMR + sedentary baseline, with logged exercise added on top.
- **AI coach chat** — ask about your day, get on-track checks, log food straight from chat.
- **PWA** — installable, offline-capable, network-first so you always get the latest version.

## Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. In **Settings → API**, copy your **Project URL** and **anon public** key.
3. In **Authentication → Providers → Anonymous**, turn **Anonymous sign-ins ON**.
   This is what keeps your data private (see Security below).
4. In **SQL Editor**, run the SQL shown on the app's setup screen (creates the tables and
   enables Row Level Security).
5. Get a free **Gemini API key** at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
6. Open the app, paste your keys, and you're in.

## Security model

NutriLog is a fully client-side app — there is no server of your own to hide secrets behind.
Two things protect your data:

- **Anonymous auth + Row Level Security (Secure Mode).** On first run the app signs in
  anonymously to your Supabase project, giving you a real `auth.uid()`. The RLS policies only
  let a user read/write rows where `user_id = auth.uid()`, so the anon API key alone cannot dump
  other people's data. New installs default to Secure Mode.
- **API keys stay on your device.** Your Gemini/Claude/Supabase keys live in this browser's
  `localStorage` and are sent directly to those services (the Gemini key is sent as a request
  header, not in the URL). Because there is no backend, anyone who can run the app with your
  Supabase project can use it — so only use trusted devices, and don't publish a copy with your
  keys baked in.

### Upgrading an older install
Existing setups stay in legacy mode so your current data keeps loading. To turn on Secure Mode:
run the latest SQL, enable Anonymous sign-ins, then **Settings → Privacy & Security → Upgrade to
Secure Mode**. The app copies a one-line migration SQL to your clipboard to move your existing
rows to your secure account.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app: UI, styles, and all logic. |
| `food_db.js` | Indian food database (`FOOD_DB`, per-100g values). |
| `sw.js` | Service worker — offline caching (bump `CACHE_NAME` when you ship changes). |
| `manifest.json` | PWA manifest (name, icons, theme). |

## Tech

Vanilla HTML/CSS/JS · Supabase (Postgres + anonymous auth) · Google Gemini / Anthropic Claude ·
html5-qrcode · OpenFoodFacts.

## Notes & limitations

- Nutrition values (AI estimates and the food DB) are approximate; use them as a guide.
- Multi-device "share your User ID" sync only works in legacy mode; Secure Mode keeps each
  account private.
