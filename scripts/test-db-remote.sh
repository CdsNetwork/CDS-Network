#!/usr/bin/env bash
# Runs the database tests against the separate test project (cds-network-portal-test),
# never the live database. Set TEST_PROJECT_REF to use another test project. Keys come
# from the Supabase CLI login and are passed only through the environment.
set -euo pipefail
ref="${TEST_PROJECT_REF:-buexeutvpznldjdvigqf}"
if [ "$ref" = "$(cat supabase/.temp/project-ref 2>/dev/null)" ]; then
  echo "Refusing to run the database tests against the linked live project ($ref)." >&2
  exit 1
fi
keys="$(supabase projects api-keys --project-ref "$ref" -o json 2>/dev/null)"
key() { printf '%s' "$keys" | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']==sys.argv[1]][0])" "$1"; }
SUPABASE_URL="https://$ref.supabase.co" SUPABASE_ANON_KEY="$(key anon)" SUPABASE_SERVICE_ROLE_KEY="$(key service_role)" \
  exec scripts/test-db.sh "$@"
