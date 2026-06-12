#!/bin/sh
set -e

# Extract host from DATABASE_URL so this works with both Docker Compose (postgres)
# and RDS (e.g. chat-analyzer-prod.xxxx.eu-central-1.rds.amazonaws.com)
DB_HOST=$(python3 -c "
import os, urllib.parse
url = os.environ.get('DATABASE_URL', '')
print(urllib.parse.urlparse(url).hostname or 'postgres')
")

echo "Waiting for postgres at $DB_HOST..."
MAX=30
i=0
until python3 -c "
import socket, sys
try:
    s = socket.create_connection(('$DB_HOST', 5432), timeout=2)
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$MAX" ] && echo "postgres unreachable after $MAX attempts, giving up." && exit 1
    echo "  not ready (attempt $i/$MAX), retrying in 1s..."
    sleep 1
done

echo "Applying migrations..."
alembic upgrade head

echo "Starting: $@"
exec "$@"
