#!/usr/bin/env bash
# Runs the database tests against the linked Supabase project. Keys come from the
# Supabase CLI login and are passed only through the environment.
set -euo pipefail
ref="$(cat supabase/.temp/project-ref)"
keys="$(supabase projects api-keys --project-ref "$ref" -o json 2>/dev/null)"
key() { printf '%s' "$keys" | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']==sys.argv[1]][0])" "$1"; }
SUPABASE_URL="https://$ref.supabase.co" SUPABASE_ANON_KEY="$(key anon)" SUPABASE_SERVICE_ROLE_KEY="$(key service_role)" \
  exec scripts/test-db.sh "$@"
