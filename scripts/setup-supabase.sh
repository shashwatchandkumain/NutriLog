#!/usr/bin/env bash
# One-time backend setup: applies the database migrations, uploads the AI keys from
# supabase/functions/.env as Edge Function secrets, and deploys the four Edge Functions.
# Run from the repo root:  npm run setup:supabase
# You will be asked to log in to Supabase (browser) and for your database password.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-tvzvsbkfmbnbeifrsfmb}"
ENV_FILE="supabase/functions/.env"
SB="npx -y supabase@latest"

cd "$(dirname "$0")/.."

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy supabase/functions/.env.example to it and add your keys." >&2
  exit 1
fi
if grep -q "YOUR_.*_HERE" "$ENV_FILE"; then
  echo "$ENV_FILE still contains placeholder keys. Add your real Gemini/Claude keys first." >&2
  exit 1
fi

echo "1/5 Logging in to Supabase…"
$SB login

echo "2/5 Linking project $PROJECT_REF (enter your database password when asked)…"
$SB link --project-ref "$PROJECT_REF"

echo "3/5 Applying database migrations…"
$SB db push

echo "4/5 Uploading Edge Function secrets…"
$SB secrets set --project-ref "$PROJECT_REF" --env-file "$ENV_FILE"

echo "5/5 Deploying Edge Functions…"
for fn in ai-food-analysis ai-chat account-recovery delete-account; do
  $SB functions deploy "$fn" --project-ref "$PROJECT_REF" --use-api
done

echo "Done. Backend is ready."
