#!/bin/sh
set -e

echo "Waiting for postgres..."
MAX=30
i=0
until python3 -c "
import socket, sys
try:
    s = socket.create_connection(('postgres', 5432), timeout=2)
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
