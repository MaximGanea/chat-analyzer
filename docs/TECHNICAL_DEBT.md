# Technical Debt & Known Gaps

**Last reviewed:** 2026-08-14 (after Phase 7 — frontend on S3 + CloudFront)

---

## 1. Known Weaknesses

- **No structured logging** — `main.py:17` creates a logger but there is no logging configuration. The application writes unstructured text to stdout with no timestamps, request IDs, or severity fields. Nothing can be aggregated or alerted on. This is the single biggest gap right now and blocks Phase 8 entirely: CloudWatch metric filters extract metrics from JSON log fields, and there are no fields to extract.
- **Health check does not touch the database** — `main.py:/api/health` returns `{"status": "ok"}` unconditionally. The Docker `HEALTHCHECK` and the CD smoke test both call it, so a container with a dead database connection reports healthy and keeps serving 500s.
- **No global exception handler** — unhandled exceptions produce FastAPI's default 500 with no server-side logging of the traceback. A production error leaves no trace anywhere.
- **`refresh_sessions` grows without bounds** — expired and revoked rows are never deleted. Over months this degrades queries and inflates backups.
- **No session limit per user** — one account can accumulate unlimited active refresh sessions. `issue_tokens` in `auth_service.py` should revoke the oldest when a user exceeds ~5.
- **Backend origin is publicly reachable** — `origin.temple-project.net` and the raw Elastic IP both answer on port 80, bypassing CloudFront and its WAF. Closing this is Step 13 of `guide/S3_CLOUDFRONT_FRONTEND.md` (shared `X-Origin-Verify` header) or, better, a security group restricted to the `com.amazonaws.global.cloudfront.origin-facing` prefix list. Deliberately deferred, not forgotten.
- **Secrets live in `backend/.env` on disk** — `JWT_SECRET_KEY` and `DATABASE_URL` are plain environment variables inside the container, visible in `docker inspect`. Both SSM jobs in `cd.yml` depend on the file path `/opt/temple-project/repo/backend/.env`, so the repo clone on EC2 exists solely to hold it. Phase 9 replaces this with Parameter Store.
- **`JWT_SECRET_KEY` has a usable default** — `config.py` defaults to `"change-me-in-prod"`. If the env var is ever missing in production the app starts happily with a publicly known signing key and every token becomes forgeable. This should fail loudly instead: no default, or a startup assertion when `ENVIRONMENT=production`.
- **RDS certificate not verified** — `database.py:_ssl_context` sets `CERT_NONE`. The connection is encrypted but the server certificate is not validated. Low risk inside a private VPC; the fix is bundling the AWS RDS CA in the image.
- **`updated_at` is unreliable** — `models.py:20` uses `onupdate=func.now()`, which only fires on ORM-level `update()` statements, not on `session.merge()` or direct attribute assignment. The column will often be stale.
- **No connection pool sizing** — `database.py` uses default pool settings (5 connections, overflow 10) per gunicorn worker. With 2 prod workers that is up to 30 connections against a `db.t4g.micro`.

---

## 2. Risk Register

| Risk | Severity | Impact |
|------|----------|--------|
| No structured logging or request IDs | High | Production incidents are undiagnosable |
| Health check ignores the database | High | Broken deploys pass the smoke test |
| `JWT_SECRET_KEY` default value | Medium | Forgeable tokens if the env var goes missing |
| Backend origin reachable directly | Medium | CloudFront and WAF bypassable by anyone who finds the IP |
| Unbounded `refresh_sessions` table | Medium | Query degradation over months |
| Secrets as plain env vars on disk | Medium | Exposure via `docker inspect` or a leaked backup |

---

## 3. Resolved Since the Last Review

Kept as a record so these do not get re-reported:

- **Rate limiting** — `slowapi` on login (10/min) and register (5/min), with `RateLimitExceeded` wired into the app.
- **Password validation** — `UserCreate.password` enforces `min_length=8, max_length=128`, closing the Argon2 long-password DoS.
- **CORS tightened** — `allow_methods` and `allow_headers` are explicit lists, origins come from `CORS_ALLOWED_ORIGINS`.
- **Tests exist** — `backend/tests/` covers the auth flow and token rotation against real PostgreSQL; the frontend has `authSlice`, `ProtectedRoute` and `AdminRoute` tests under vitest. Both run in CI on every PR and again on merge.
- **`HEALTHCHECK` in the Dockerfile** — present in the prod stage.
- **Backend port no longer public** — the container publishes to `127.0.0.1:8000` only; nginx is the sole path in.
- **HTTPS everywhere** — CloudFront terminates TLS with an auto-renewing ACM certificate. certbot and its cron job are gone from EC2.
- **RDS with automated backups** — replaced the containerised postgres in Phase 5.
- **MUI removed** — no UI library is imported anywhere; the inconsistent `Typography` import in `AdminPage.jsx` is gone.
- **`venv/` not tracked** — confirmed absent from git.
- **Migrations no longer run on container start** — `entrypoint.sh` gates `alembic upgrade head` behind `RUN_MIGRATIONS=1`, set only by `docker-compose.yml` for local development. Production relies on the `migrate` job in `cd.yml`, as `CLAUDE.md` requires.
- **Dead frontend production image removed** — the `prod` and `build` stages are gone from `frontend/Dockerfile` and `frontend/nginx.conf` is deleted. The frontend image now only has a `dev` stage for Vite HMR.
- **`docker-compose.prod.yml` deleted** — commit `419245c`; every service it defined is now RDS, ECR or S3.

---

## 4. Component Assessment

### 4.1 Backend

The auth layer itself is in good shape: argon2 hashing, short-lived access tokens held only in memory, opaque refresh tokens stored SHA-256 hashed with rotation on every use, rate limiting on both entry points, and tests that cover revocation and concurrent refresh.

What is missing is everything around it. There is no request logging middleware, no correlation ID linking a user's error report to a log line, no exception handler, and a health check that cannot detect the failure mode it exists to catch. Phase 2 of `TODOS.md` addresses all four and should be done before Phase 8.

### 4.2 Frontend

**Gaps:**
- No error boundaries — an uncaught render error shows a blank white screen.
- `ProtectedRoute` renders raw `<p>Checking session...</p>` during bootstrap rather than a real loading state.
- No code splitting or bundle analysis. Not urgent now that MUI is gone and CloudFront caches hashed assets for a year, but worth measuring before the chat-analysis features land.

### 4.3 Database

**Gaps:**
- Stale `refresh_sessions` rows are never cleaned up. A scheduled `DELETE FROM refresh_sessions WHERE expires_at < now() OR revoked_at IS NOT NULL` is still outstanding from Phase 3.
- Pool sizing is untuned (see section 1).
- Restore has never been exercised. Automated snapshots exist; a snapshot you have never restored is a hypothesis, not a backup.

### 4.4 Authentication and Security

**Gaps:**
- No account lockout after N failed logins — rate limiting slows an attacker per IP but does not protect a single targeted account from a distributed attempt.
- No email verification. Any address can register, including disposable and spoofed ones.
- No session limit per user (see section 1).
- CSRF protection rests on `SameSite=Lax` alone. The refresh cookie is scoped to `Path=/api/auth`, which narrows the surface, but a double-submit token would be stronger.
- Test account `cf-test@example.com` (id 2) was created against the production database while validating CloudFront. Delete it.

### 4.5 Infrastructure

**Gaps:**
- EC2 remains a pet: nginx, Docker and the `.env` file were all configured by hand and are not reproducible from code. Rebuilding it means following `guide/PRODUCTION_RESTORE.md` by hand.
- No infrastructure as code. Every AWS resource — the distribution, bucket, role, DNS records — was created through the console. Nothing describes the intended state, so drift is invisible.
- Single AZ, single instance. Acceptable at this stage; Phase 9 covers Multi-AZ and an ALB.

### 4.6 Configuration Management

**Gaps:**
- One `.env` per service, no separation between staging and production.
- `APP_DEBUG=true` in `.env.example` — harmless as an example, but it is the file people copy.
- Secrets as plain environment variables (see section 1).
