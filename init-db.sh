#!/bin/bash
# PostgreSQL initialization script - runs migrations when container starts

set -e

PSQL_EXECUTABLE=$(which psql)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/src/server/db/migrations"

echo "Starting SK-KIT PostgreSQL initialization..."

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
until PGPASSWORD="$POSTGRES_PASSWORD" $PSQL_EXECUTABLE -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1" > /dev/null 2>&1; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 1
done

echo "PostgreSQL is ready!"

# Apply migrations in order
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Migrations directory not found at $MIGRATIONS_DIR"
  exit 1
fi

# Refuse to report success having applied nothing. The glob below is guarded
# with 2>/dev/null, so an empty or wrong directory previously produced a silent
# no-op that still printed "All 0 migrations applied successfully" — false
# confidence at exactly the moment the schema is missing.
if [ -z "$(ls "$MIGRATIONS_DIR"/[0-9]*.sql 2>/dev/null)" ]; then
  echo "✗ No migration files matched $MIGRATIONS_DIR/[0-9]*.sql — refusing to report success."
  exit 1
fi

# Counter for successful migrations
MIGRATION_COUNT=0

# Find and execute all migration files in order
for migration_file in $(ls "$MIGRATIONS_DIR"/[0-9]*.sql 2>/dev/null | sort); do
  echo "Applying migration: $(basename "$migration_file")"

  PGPASSWORD="$POSTGRES_PASSWORD" $PSQL_EXECUTABLE \
    -h localhost \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -f "$migration_file"

  if [ $? -eq 0 ]; then
    echo "✓ $(basename "$migration_file") applied successfully"
    ((MIGRATION_COUNT++))
  else
    echo "✗ Failed to apply $(basename "$migration_file")"
    exit 1
  fi
done

echo "✓ All $MIGRATION_COUNT migrations applied successfully"
echo "SK-KIT database initialization complete!"
