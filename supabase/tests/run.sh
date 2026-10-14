#!/usr/bin/env bash
# Runs the database tests against a throwaway local PostgreSQL 16 cluster.
#   bash supabase/tests/run.sh
# Needs the PostgreSQL server binaries (initdb, pg_ctl) and psql. Nothing touches Supabase.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUPA="$(cd "$HERE/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGTEST_PORT:-54329}"
WORK="$(mktemp -d /tmp/snowy-pgtest.XXXXXX)"
chmod 755 "$WORK"

# Postgres refuses to run as root: use the 'postgres' user if we're root.
RUNAS=()
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || useradd -r -M pgtest
  U=$(id -un postgres 2>/dev/null || echo pgtest)
  chown "$U" "$WORK"
  RUNAS=(runuser -u "$U" --)
fi

cleanup() {
  "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust -E UTF8 >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c wal_level=logical" -l "$WORK/log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

step() { printf '\n== %s\n' "$1"; }

step "shim + migrations + seed"
"${PSQL[@]}" -f "$HERE/00_supabase_shim.sql"
for f in "$SUPA"/migrations/*.sql; do echo "  applying $(basename "$f")"; "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f "$SUPA/seed.sql"
"${PSQL[@]}" -f "$SUPA/seed.sql"   # seed must be re-runnable
echo "  ok"

step "fixtures"
"${PSQL[@]}" -f "$HERE/10_fixtures.sql"

FAILED=0
# pipefail (set above) makes a failing psql fail the pipeline even though sed succeeds.
run_test() { "${PSQL[@]}" -f "$1" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  /  /' -e 's/^NOTICE:  /  /' || FAILED=1; }

for f in "$HERE"/[2-7]*_*.sql; do
  step "$(basename "$f")"
  run_test "$f"
done

step "concurrency: 10 clients race for 3 spots"
"${PSQL[@]}" -f "$HERE/80_concurrency_setup.sql"
pids=()
GO=$(python3 -c 'import time; print(time.time() + 2)' 2>/dev/null || echo $(( $(date +%s) + 2 )))
for i in $(seq 1 10); do
  "${PSQL[@]}" -c "select test.login('race$i')" -c "select test.at('2026-10-19 08:00+11')" \
               -c "select pg_sleep_until(to_timestamp($GO))" -c "select public.book_class(test.id('race_session'))" >/dev/null 2>"$WORK/race$i.err" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || { echo "  a racing booking errored:"; cat "$WORK"/race*.err; FAILED=1; }; done
run_test "$HERE/81_concurrency_check.sql"

step "import template"
run_test "$HERE/90_import.sql"

echo
if [ "$FAILED" = "0" ]; then echo "ALL DATABASE TESTS PASSED"; else echo "SOME DATABASE TESTS FAILED"; exit 1; fi
