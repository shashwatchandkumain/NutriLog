// ─────────────────────────────────────────────────────────────────────────────
// NutriLog PUBLIC client configuration
//
// These two values are designed to be public: they ship to every browser that opens the
// app, and GitHub Pages serves them openly. Your data is protected by Supabase Auth and Row
// Level Security (see supabase/migrations), not by hiding these values.
//
//   SUPABASE_URL       Supabase Dashboard → Project Settings → API → Project URL
//   SUPABASE_ANON_KEY  Supabase Dashboard → Project Settings → API Keys →
//                      "anon public" key (or the "publishable" key, sb_publishable_...)
//
// NEVER put any of these here (or anywhere in the website):
//   ✗ the service_role / secret key (sb_secret_...)   ✗ the database password
//   ✗ GEMINI_API_KEY   ✗ CLAUDE_API_KEY
// Those belong in Supabase → Edge Functions → Secrets. See README.md.
//
// The GitHub Actions workflow (.github/workflows/deploy.yml) can also write this file from
// repository variables at deploy time, so you don't have to commit the values.
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  SUPABASE_URL: 'https://tvzvsbkfmbnbeifrsfmb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2enZzYmtmbWJuYmVpZnJzZm1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NDgxMjYsImV4cCI6MjA5MzUyNDEyNn0.NJKgV_f3iH7gKLZ0LXZT6sYQ-DTghmRWQ_zNuc3yGTk',

  // Show "Continue with Google" (requires Google to be enabled in Supabase → Authentication → Providers).
  ENABLE_GOOGLE_AUTH: false,
};
