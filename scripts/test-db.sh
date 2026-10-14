#!/usr/bin/env bash
# Runs the database tests. Against the local stack by default (supabase start), or
# against another project when SUPABASE_URL, SUPABASE_ANON_KEY and
# SUPABASE_SERVICE_ROLE_KEY are already set in the environment.
set -euo pipefail

if [ -z "${SUPABASE_URL:-}" ]; then
  status="$(supabase status -o env 2>/dev/null)" || {
    echo "Local Supabase is not running. Start it with: supabase start" >&2
    exit 1
  }
  SUPABASE_URL="$(printf '%s\n' "$status" | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
  SUPABASE_ANON_KEY="$(printf '%s\n' "$status" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
  SUPABASE_SERVICE_ROLE_KEY="$(printf '%s\n' "$status" | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
  export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY

  # The local storage service creates its tables after migrations run.
  db_url="$(printf '%s\n' "$status" | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
  psql "$db_url" -X -q -v ON_ERROR_STOP=1 -c 'select private.ensure_storage()' >/dev/null
fi

exec npx vitest run "$@"
