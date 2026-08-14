# Backend Healthcheck

## What was added

Two pieces work together:

**1. The `/health` endpoint** (`backend/app/main.py:47`)

```python
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

A plain HTTP `200 OK` with body `{"status": "ok"}`. It has no DB dependency — it only tells Docker that the process is up and responding. This is intentional: a deep-health check that also pings the DB can mask the real failure source and makes the healthcheck harder to reason about.

**2. The `HEALTHCHECK` instruction** (`backend/Dockerfile:37`, `prod` stage only)

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1
```

| Flag | Value | Meaning |
|------|-------|---------|
| `--interval` | 30s | Docker probes every 30 seconds after the container starts |
| `--timeout` | 5s | If `curl` hasn't returned within 5 seconds, that probe counts as failed |
| `--start-period` | 15s | Failures in the first 15 seconds don't count toward `--retries` — gives gunicorn time to bind and warm up |
| `--retries` | 3 | Three consecutive failures flip the container status to `unhealthy` |

`curl -f` makes curl exit non-zero on any HTTP 4xx/5xx, so a 500 from the app also marks the probe failed.

### Why only the `prod` stage?

The `dev` stage uses a volume-mounted source with `--reload`, so gunicorn restarts frequently during development. A healthcheck there would create noise and occasionally block hot-reload cycles. `docker-compose.yml` (dev) depends on the backend via a plain `depends_on: - backend` without `condition: service_healthy`, which is fine for local work.

The `prod` stage uses `curl`, which is explicitly installed in the Dockerfile (`apt-get install -y curl`) because `python:3.12-slim` does not include it.

---

## How Docker uses the healthcheck

Docker tracks three container states:

- **starting** — within the `--start-period`, probes may fail without consequence
- **healthy** — the last probe returned exit 0
- **unhealthy** — `--retries` consecutive probes failed

Compose and orchestrators (ECS, Kubernetes via liveness/readiness probes, Swarm) can act on `unhealthy` — restarting the container or stopping traffic to it.

The production container is started by `cd.yml` with `--restart unless-stopped`, so Docker will automatically restart a container that crashes, but **`restart` is independent of the healthcheck** — a process can be running but `unhealthy`, and Docker will not restart it on healthcheck failure alone without an orchestrator policy (e.g., `--health-action restart` in standalone Docker, or the restart policy in Swarm/ECS).

---

## How to test it

### 1. Curl the endpoint directly

With the stack running:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

### 2. Check the container health status

```bash
# show health status column
docker ps --format "table {{.Names}}\t{{.Status}}"

# detailed probe history (last 5 results, exit codes, output)
docker inspect --format='{{json .State.Health}}' temple-project-backend-1 | jq
```

The `.State.Health.Log` array shows the last N probe results with `ExitCode`, `Output`, and `Start`/`End` timestamps.

### 3. Watch it transition from `starting` → `healthy`

Start only the prod target, then watch status in real time:

```bash
docker build -t temple-project-backend:latest ./backend --target prod
watch -n 2 "docker inspect --format='{{.State.Health.Status}}' temple-project-backend-1"
```

Within 15 seconds (start-period) the status should move from `starting` to `healthy`.

### 4. Force an `unhealthy` state

Stop the app process inside the container without stopping the container itself, then observe the probe failing:

```bash
# kill gunicorn master inside the running container
docker exec temple-project-backend-1 pkill gunicorn

# watch health status flip to unhealthy after 3 failed probes (~90s)
watch -n 5 "docker inspect --format='{{.State.Health.Status}}' temple-project-backend-1"
```

Because `restart: unless-stopped` is set, Docker will restart the container once the process dies — you may see it cycle back to `starting` before you observe `unhealthy` depending on timing.

### 5. Verify curl is available in the prod image

The healthcheck command requires `curl`. Confirm it is present:

```bash
docker run --rm temple-project-backend:latest curl --version
```

This should print the curl version. If it fails, check the `apt-get install curl` step in the `prod` stage of `backend/Dockerfile`.
