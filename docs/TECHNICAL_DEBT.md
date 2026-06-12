# Technical Debt & Known Gaps

**Last reviewed:** 2026-06-08

---

## 1. Known Weaknesses

- **No rate limiting** — `POST /api/auth/login` has no brute-force protection. An attacker can try millions of password combinations.
- **No password validation** — `schemas.py:UserCreate` accepts `password: str` with no minimum length, complexity, or maximum length constraint. An attacker can submit a 1,000,000-character password to induce a CPU spike during hashing (Argon2 DoS).
- **`refresh_sessions` grows without bounds** — expired and revoked rows are never deleted. Over time this table becomes a liability: slow queries, large backups, storage cost.
- **No structured logging** — `main.py:13` creates a logger but there is no logging configuration. Logs are unstructured text printed to stdout without timestamps, request IDs, or severity levels parseable by log aggregation tools.
- **Backend port exposed in production** — `docker-compose.prod.yml:23` publishes `8000:8000` to the host. In production, the backend should only be reachable internally via nginx.
- **DB credentials as plain environment variables** — `docker-compose.yml:5` hardcodes `POSTGRES_PASSWORD: chat_pass`. In production, these should come from a secrets manager (AWS Secrets Manager, Docker secrets).
- **No connection pool sizing** — `database.py:10` uses `create_async_engine` with default pool settings (5 connections, overflow 10). Under load or with multiple workers, this requires tuning.
- **Inconsistent UI library usage** — `AdminPage.jsx:1` imports MUI `Typography`, while all other pages use raw HTML. MUI is 300 KB+ of dependency weight.
- **venv committed to repository** — The `backend/venv/` directory is tracked in git. This is ~100 MB of generated code. The `backend/.gitignore` excludes `venv/` but the directory appears to exist.
- **`updated_at` server-side trigger not reliable** — `models.py:21` sets `onupdate=func.now()`. With async SQLAlchemy, this only fires on ORM-level updates through `update()`, not through `session.merge()` or direct attribute assignment. In practice `updated_at` will often not be updated as expected.

---

## 2. Risk Register

| Risk | Severity | Impact |
|------|----------|--------|
| No rate limiting on login | High | Credential stuffing / brute force |
| No password min length | Medium | Argon2 DoS via long passwords |
| Unbounded refresh_sessions table | Medium | Query degradation over months |
| No tests | High | Regressions undetected until production |
| Secrets in environment variables | Medium | Leaked in logs or ps output |
| Single DB with no backups | High | Total data loss on disk failure |
| No HTTPS configuration | High | Credentials transmitted in plaintext |

---

## 3. Component Assessment

### 3.1 Backend

**Gaps:**
- No request logging middleware. Without this, debugging a reported issue in production is guesswork.
- No correlation/request ID. When a user reports an error, you need a trace ID that appears in both the HTTP response and the log line.
- No rate limiting. `slowapi` (FastAPI-native, backed by Redis) should wrap the login and register endpoints.
- No global exception handler. Unhandled exceptions produce FastAPI's default 500 response, which may leak stack traces depending on the `debug` setting.
- The health endpoint at `GET /health` returns `{"status": "ok"}` without checking database connectivity. A real health check should run `SELECT 1` so load balancers can route around a broken DB connection.

**Impact:** Without request logging and a proper health check, a production incident is extremely difficult to diagnose. Without rate limiting, the authentication system is open to automated attacks.

### 3.2 Frontend

**Gaps:**
- No error boundaries. An uncaught JavaScript error anywhere in the component tree will show a blank white screen with no user feedback.
- No loading skeletons or proper UX states. `ProtectedRoute` shows `<p>Checking session...</p>` during bootstrap — a flash of raw text before the UI renders.
- No bundle analysis or code splitting. MUI is imported in `AdminPage.jsx` only, but because there is no lazy loading, the full MUI bundle is included in the initial chunk.
- Password field has no `minLength` or `maxLength` HTML attributes. A 1-character password passes client-side validation.

**Impact:** The VITE_API_URL issue is blocking for production. The others are quality-of-life issues.

### 3.3 Database

**Gaps:**
- No automated backups. If the host disk fails, all data is lost.
- No connection pooling middleware (e.g., PgBouncer). Each uvicorn worker opens its own SQLAlchemy connection pool. With 2 workers and 5 connections each, the backend holds 10 persistent connections — this multiplies as you scale.
- Stale session cleanup is missing. Expired/revoked `refresh_sessions` accumulate forever. A weekly `DELETE FROM refresh_sessions WHERE expires_at < now() OR revoked_at IS NOT NULL` is required.

**Impact:** No backups is the single highest-risk gap.

### 3.4 Authentication and Security

**Gaps:**
- No account lockout after N failed login attempts.
- No email verification. Any email address can be registered, including spoofed or disposable addresses.
- No session limit per user. One account can accumulate unlimited active sessions.
- `JWT_SECRET_KEY` defaults to `"change-me-in-prod"` in `config.py:19`. If this default is ever used in production, all tokens become forgeable.
- CORS `allow_methods=["*"]` and `allow_headers=["*"]` in `main.py:31` are overly permissive.
- No CSRF protection beyond `SameSite=Lax`. For maximum safety, `SameSite=Strict` or a CSRF token double-submit is preferable.

### 3.5 Docker and Containerization

**Gaps:**
- The backend `Dockerfile` may copy the `venv/` directory. Verify `.dockerignore` excludes it.
- Running migrations inside `entrypoint.sh` is a race condition when multiple backend replicas start simultaneously. The migration step should be a separate one-off task run before deploying containers (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- No `HEALTHCHECK` instruction in the backend `Dockerfile`. Docker (and orchestrators) cannot determine whether the container is actually serving traffic.
- `docker-compose.prod.yml` has no resource limits (`mem_limit`, `cpus`). Without limits, a runaway process can starve other containers.

### 3.6 Configuration Management

**Gaps:**
- Only one `.env` file per service. A production system needs distinct configurations for development, staging, and production with no crossover of credentials.
- Secrets (JWT key, DB password) are passed as plain environment variables. They appear in `docker inspect`, `ps aux`, and container logs. AWS Secrets Manager or HashiCorp Vault should provide secrets at runtime.
- `APP_DEBUG=true` appears in `.env.example`. In any production-adjacent environment, debug mode should be explicitly set to false and enforced.

### 3.7 Logging and Error Handling

**Gaps:**
- No structured logging (JSON). Log aggregation tools (CloudWatch, Datadog, Loki) work best with JSON logs where `level`, `timestamp`, `request_id`, `user_id`, `path`, `status_code`, and `duration_ms` are discrete queryable fields.
- No global exception handler. Unhandled exceptions produce default FastAPI 500 responses with no context logging.
- No frontend error reporting. Client-side JavaScript errors are invisible unless the user reports them. Integrate Sentry or similar.

### 3.8 Testing

**Current state:** No tests exist. There is no `tests/` directory, no pytest configuration, no jest/vitest setup.

**Impact:** Any change to `auth_service.py` or `security.py` can silently break authentication without detection. Token rotation logic in particular is tricky — a bug there could log users out globally or allow session reuse after revocation.
