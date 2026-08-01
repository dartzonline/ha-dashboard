#!/usr/bin/env zsh
set -euo pipefail

project_dir="${0:A:h}"
cd "$project_dir"

if [[ ! -f backend/.env ]]; then
  print -u2 "Missing backend/.env. Copy backend/.env.example and add HA_URL and HA_TOKEN."
  exit 1
fi

print "Building dashboard..."
npm --prefix frontend run build

exec backend/.venv/bin/uvicorn app.main:app \
  --app-dir backend \
  --env-file backend/.env \
  --host 0.0.0.0 \
  --port "${PORT:-8000}"
