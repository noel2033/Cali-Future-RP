#!/usr/bin/env bash
# TitanBot Cloud Agent — per-boot startup.
# Brings the PostgreSQL cluster online and verifies the schema, then returns.
# Must tolerate restarts and be idempotent.
set -euo pipefail

PGVER="$(ls /etc/postgresql 2>/dev/null | sort -n | tail -1)"
if [ -z "${PGVER:-}" ]; then
  echo "!! PostgreSQL is not installed; run .cursor/install.sh first" >&2
  exit 1
fi

echo "==> [start] Starting PostgreSQL ${PGVER} cluster"
sudo pg_ctlcluster "${PGVER}" main start 2>/dev/null || true

echo "==> [start] Waiting for PostgreSQL to accept connections"
for _ in $(seq 1 30); do
  sudo -u postgres pg_isready -q && break
  sleep 1
done
sudo -u postgres pg_isready || { echo "!! PostgreSQL did not become ready" >&2; exit 1; }

# Ensure role/database exist even if the snapshot predates provisioning.
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='titanbot'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE titanbot LOGIN PASSWORD 'password';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='titanbot'" | grep -q 1 \
  || sudo -u postgres createdb -O titanbot titanbot

echo "==> [start] PostgreSQL is ready on 127.0.0.1:5432 (db: titanbot)"
