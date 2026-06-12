# Action Items & Readiness Checklist

**Last reviewed:** 2026-06-08

---

## 1. Learning Path

### Phase 1: Fix What's Broken (1 week)

**Objective:** Make the existing code correct and understand how the pieces fit together.

**Tasks:**
1. Add `minLength=8`, `maxLength=128` to `UserCreate.password` in `schemas.py`. Why: Argon2 becomes a DoS vector with unbounded input — a 1M-character password causes a CPU spike during hashing.
2. Add `HEALTHCHECK` to `backend/Dockerfile` prod stage. Test by killing the backend process inside the container and observing `docker ps` status.
3. Study how nginx, Vite proxy, and Axios interact with URL paths. Draw a diagram of the request path for each environment (local outside Docker, Docker dev, Docker prod).

**Validation:** `docker compose -f docker-compose.prod.yml up --build` runs and all auth routes work end-to-end from a browser.

---

### Phase 2: Observability (1–2 weeks)

**Objective:** Add logging and a real health check so you can diagnose issues in production.

**Tasks:**
1. Add a logging configuration to `main.py` using Python's `logging.config.dictConfig` with a JSON formatter (`python-json-logger`). Every log line should emit `timestamp`, `level`, `logger`, and `message` as JSON fields.
2. Add a request logging middleware that logs `method`, `path`, `status_code`, `duration_ms`, and a per-request UUID also returned in the `X-Request-ID` response header.
3. Upgrade the `/health` endpoint to query the database:
   ```python
   @app.get("/health")
   async def health(db: AsyncSession = Depends(get_db)):
       await db.execute(text("SELECT 1"))
       return {"status": "ok", "db": "connected"}
   ```
4. Add a global exception handler that logs the full stack trace with the `request_id` and returns a sanitized 500 response (no stack trace in the response body).
5. Trigger a 500 locally, find the log line. Then trigger the same error on a deployed instance and find it in CloudWatch Logs.

**Validation:** You can grep a `request_id` from a client error report and find the corresponding server-side log line within seconds.

---

### Phase 3: Security Hardening (1–2 weeks)

**Objective:** Close the security gaps that expose the application to automated attacks.

**Tasks:**
1. Add rate limiting with `slowapi`. Limit `POST /api/auth/login` to 5 requests per minute per IP. What is the difference between IP-based and user-based rate limiting?
2. Add a per-user session limit to `issue_tokens` in `auth_service.py`: if a user has more than 5 active sessions, revoke the oldest before creating a new one.
3. Tighten CORS: replace `allow_methods=["*"]` with `["GET", "POST", "PUT", "DELETE"]` and `allow_headers=["*"]` with `["Authorization", "Content-Type"]`.
4. Generate a strong JWT secret and understand what happens to all existing tokens when you rotate the secret. How do you rotate without logging everyone out?
5. Add the stale session cleanup query as a scheduled task (FastAPI startup event or separate management command).

**Validation:** Run `ab -n 100 -c 10 -p login.json -T application/json http://localhost:8000/api/auth/login`. Confirm responses start returning 429 after the rate limit is hit.

---

### Phase 4: Testing (2 weeks)

**Objective:** Write tests that give you confidence to deploy without manual verification.

**Tasks:**
1. Set up `pytest` + `pytest-asyncio` + `httpx` in the backend. Write a `conftest.py` that creates a fresh PostgreSQL test schema and tears it down after each test. Not SQLite — use PostgreSQL.
2. Write `test_auth.py` covering: register → login → refresh → logout → verify token invalidated.
3. Write `test_token_rotation.py` covering: revoked token reuse rejected, expired token rejected, concurrent refresh produces exactly one valid session.
4. Set up `vitest` in the frontend. Write tests for `authSlice.js` using a mock API.
5. Write component tests for `ProtectedRoute` and `AdminRoute` with `@testing-library/react`.
6. Add a GitHub Actions CI workflow that runs all tests. Confirm the workflow blocks merges when tests fail.

**Validation:** Comment out `session.revoked_at = datetime.now(UTC)` in `auth_service.py:87`. Confirm the token rotation test catches it immediately.

---

### Phase 5: First Production Deployment (1 week)

**Objective:** Deploy the application to a real server accessible from the internet.

**Tasks:**
1. Provision an EC2 t3.small with an Elastic IP. What is an Elastic IP and why does it matter for DNS?
2. Create an RDS PostgreSQL instance in a private subnet. Connect from EC2 using `psql`. Understand VPC, public subnet, private subnet, security group.
3. Configure nginx with certbot for HTTPS. What is TLS termination and why does it belong at the edge?
4. Deploy the backend container. Run migrations. Verify the health endpoint responds.
5. Build the frontend with `VITE_API_URL=` (empty), deploy to `/var/www/html`. Verify the full login flow end-to-end from a different machine.
6. Set up automated RDS snapshots. What is the difference between an RDS automated backup and a manual snapshot?

**Validation:** From your phone (not your development machine), create an account, log in, and log out.

---

### Phase 6: CI/CD and Automation (1–2 weeks)

**Objective:** Never deploy manually again.

**Tasks:**
1. Create the GitHub Actions CI workflow (see [DEPLOYMENT.md](DEPLOYMENT.md#82-ci-workflow)). Make it run on every PR.
2. Create the deployment workflow. Make it trigger on merge to `main`.
3. Store secrets in GitHub Actions Environments. Why can't you store secrets in the repository, even in a private repo?
4. Add the `migrate` job before `deploy-backend`. What happens if you deploy new code before running migrations?
5. Implement a smoke test in the deploy workflow: `curl` the health endpoint after deployment and verify it returns `{"status": "ok"}`. Stop if it fails.

**Validation:** Make a code change, push to a feature branch, open a PR, watch CI pass, merge, watch the deployment push the change to production — all without a manual command.

---

### Phase 7: Scalability and Resilience (ongoing)

**Objective:** Understand the limits of the current architecture and how to address them.

**Tasks:**
1. Add PgBouncer. Load test with `locust` and observe connection counts on the RDS side with and without pooling.
2. Migrate the frontend to S3 + CloudFront. What is edge caching and how does `Cache-Control: immutable` interact with it?
3. Migrate the backend to ECS Fargate with a target-tracking auto-scaling policy. What is a target group health check and how does it differ from a Docker HEALTHCHECK?
4. Set up CloudWatch alarms for: `5xx error rate > 1%`, `latency p99 > 2s`, `CPU > 80%`.
5. Simulate a failure: terminate the RDS instance and observe recovery time. Then enable Multi-AZ and repeat. What is the actual RTO/RPO of each configuration?

---

## 2. Production Readiness Checklist

Use this checklist before accepting live traffic. Each item is independently verifiable.

### Backend

- [ ] All API routes return correct status codes; verified with `httpx` integration tests
- [ ] `POST /api/auth/login` returns 429 after N requests from the same IP (rate limiter active)
- [ ] `POST /api/auth/register` rejects passwords shorter than 8 characters with 422
- [ ] `POST /api/auth/register` rejects passwords longer than 128 characters with 422
- [ ] `GET /health` returns 200 with database connectivity check
- [ ] `GET /health` returns 503 (not 200) when the database is unreachable
- [ ] Unhandled exceptions return 500 with a generic message — no stack trace in response body
- [ ] Every HTTP response includes an `X-Request-ID` header
- [ ] Request logs are emitted as JSON with `request_id`, `path`, `method`, `status_code`, `duration_ms`
- [ ] `APP_DEBUG=false` confirmed in production environment
- [ ] `JWT_SECRET_KEY` is a randomly generated 256-bit value (not a dictionary word)
- [ ] `CORS_ALLOWED_ORIGINS` lists only production domain(s), not `*` or localhost
- [ ] gunicorn (not uvicorn standalone) runs the backend in production
- [ ] Migrations run separately before container deployment — not inside the entrypoint
- [ ] Stale `refresh_sessions` cleanup job is scheduled and verified

### Frontend

- [ ] Production build succeeds with `VITE_API_URL=` (empty)
- [ ] All API calls use same-domain relative paths in production build (verify with browser DevTools)
- [ ] No `console.log` or debug output in the production bundle
- [ ] Error boundary wraps the router; uncaught errors show a fallback UI, not a blank screen
- [ ] Login and register forms have `minLength` and `maxLength` attributes on password field
- [ ] Bundle size analyzed; no unexpected large dependencies (`npm run build` shows chunk sizes)
- [ ] Static assets have `Cache-Control: public, immutable` with content-hash filenames
- [ ] `index.html` has `Cache-Control: no-cache` (so deploys are seen immediately)

### Database

- [ ] Automated daily backups enabled with at least 7-day retention
- [ ] A backup restoration has been tested (restored to a test instance and verified data integrity)
- [ ] Deletion protection enabled on the RDS instance
- [ ] Database is not publicly accessible (reachable only from backend security group)
- [ ] `max_connections` on RDS is set above total possible connections from all backends
- [ ] All migrations have tested `downgrade()` functions
- [ ] PgBouncer or RDS Proxy is in front of RDS
- [ ] Stale session cleanup verified: expired rows are actually deleted by the scheduled job

### Infrastructure

- [ ] TLS certificate installed; `https://` works and HTTP redirects to HTTPS
- [ ] TLS certificate auto-renewal configured and tested (`certbot renew --dry-run`)
- [ ] Backend port 8000 is NOT exposed to the public internet (only accessible via nginx proxy)
- [ ] SSH access to EC2 is restricted to known IP ranges (not `0.0.0.0/0`)
- [ ] EC2 instance has an Elastic IP (IP does not change on restart)
- [ ] DNS TTL is set low enough for failover (300 seconds or less)
- [ ] Resource limits (`mem_limit`, `cpus`) set on all containers in production compose

### Security

- [ ] All secrets (JWT key, DB password) sourced from a secrets manager — not hardcoded in env files on disk
- [ ] `.env` files are not tracked in git (`git log --all --full-history -- '**/.env'`)
- [ ] `venv/` directory is not tracked in git
- [ ] HTTP Security Headers present: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- [ ] Dependency scan run: `pip-audit` for backend, `npm audit` for frontend — no high/critical issues
- [ ] CORS `allow_origins` does not include `*`

### CI/CD

- [ ] All tests pass in CI against a real PostgreSQL database (not SQLite)
- [ ] CI blocks merges to `main` when tests fail
- [ ] Deployments are fully automated — no manual steps required
- [ ] Migration runs as a separate CI job before the backend deploy job
- [ ] Production secrets are stored in CI environment secrets — not in the repository
- [ ] Each deployment is tagged with a git SHA; rollback is a one-command operation
- [ ] Post-deployment smoke test (health check) automatically verifies the deployment succeeded

### Observability

- [ ] Structured JSON logs are shipped to a central log store (CloudWatch, Datadog, Loki)
- [ ] Alarms configured for: 5xx error rate > 1%, p99 latency > 2 seconds, CPU > 80%
- [ ] On-call notification path is tested (alarm fires and reaches a human)
- [ ] Client-side error reporting integrated (Sentry or equivalent)
- [ ] Database slow query log is enabled and reviewed before launch
- [ ] A runbook exists for the top 3 most likely incidents: DB unreachable, OOM kill, certificate expiry
