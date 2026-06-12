# Action Items & Readiness Checklist

**Last reviewed:** 2026-06-12

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

See `PHASE5_PRODUCTION_DEPLOYMENT.md` for the full step-by-step guide.

**Tasks:**
1. Provision an EC2 t3.small with an Elastic IP and connect via SSM Session Manager (no open SSH port). What is an Elastic IP and why does it matter for DNS?
2. Create an RDS PostgreSQL instance in a private subnet. Connect from EC2 using `psql`. Understand VPC, public subnet, private subnet, security group.
3. Configure nginx with certbot for HTTPS. What is TLS termination and why does it belong at the edge?
4. Deploy the backend container. Run migrations. Verify the health endpoint responds.
5. Build the frontend on the server, deploy to `/var/www/html`. Verify the full login flow end-to-end from a different machine.
6. Set up automated RDS snapshots. What is the difference between an RDS automated backup and a manual snapshot?

**Validation:** From your phone (not your development machine), create an account, log in, and log out.

---

### Phase 6: CI/CD and Automation (1–2 weeks)

**Objective:** Never deploy manually again.

**Tasks:**
1. Create an **ECR (Elastic Container Registry)** repository named `chat-analyzer-backend`. Push the backend Docker image to it from your local machine manually first to understand the flow. Why use ECR over Docker Hub for private AWS deployments?
2. Create the GitHub Actions CI workflow. Run on every PR: install deps, run backend tests against a real PostgreSQL service container, run frontend tests.
3. Create the **CD workflow**: on merge to `main` — build the Docker image, push to ECR, connect to EC2 via `aws ssm start-session` and pull + restart the container. Store the AWS credentials in GitHub Actions Environments (not repository secrets — what is the difference?).
4. Add the `migrate` job before `deploy-backend`. What happens if you deploy new code before running migrations?
5. Implement a smoke test in the deploy workflow: `curl` the health endpoint after deployment and verify it returns `{"status": "ok"}`. Fail the workflow if it does not.
6. Tag each deployment with the git SHA: `docker build -t chat-analyzer-backend:${{ github.sha }}`. How does this enable one-command rollback?

**Validation:** Make a code change, push to a feature branch, open a PR, watch CI pass, merge, watch the deployment push the change to production — all without a manual command.

---

### Phase 7: Frontend to S3 + CloudFront (1 week)

**Objective:** Stop serving static files from EC2. Offload the frontend to a managed CDN so nginx only handles API proxying.

**Why:** The React build is a set of static files — there is no reason to serve them from a compute instance. S3 + CloudFront gives you a global CDN, near-zero cost at this scale, and removes one reason to touch the EC2 instance.

**Tasks:**
1. Create an S3 bucket named `chat-analyzer-frontend`. Enable **static website hosting**. Block all public access and serve exclusively through CloudFront (never expose the bucket directly). Why does serving through CloudFront instead of S3 directly matter for security and performance?
2. Request an **ACM (AWS Certificate Manager)** certificate for `yourdomain.com` and `www.yourdomain.com` in `us-east-1` (required for CloudFront). ACM auto-renews — no certbot needed for the frontend. What is the difference between DNS validation and email validation for ACM?
3. Create a **CloudFront distribution**:
   - Origin: the S3 bucket (via Origin Access Control, not a public bucket URL)
   - Default behavior: route to S3
   - `/api/*` behavior: route to your EC2 Elastic IP
   - Viewer protocol: HTTPS only, redirect HTTP
   - Attach the ACM certificate
4. Update DNS: point `yourdomain.com` to the CloudFront distribution domain, not the Elastic IP directly.
5. Set correct `Cache-Control` headers:
   - Hashed assets (`/assets/*.js`, `/assets/*.css`): `Cache-Control: public, max-age=31536000, immutable`
   - `index.html`: `Cache-Control: no-cache` — so deploys are visible immediately
6. Update the CI/CD deploy workflow: build the frontend in the GitHub Actions runner and sync to S3 with `aws s3 sync --delete`. Add a CloudFront invalidation for `index.html` after each deploy.
7. Remove the nginx static file serving config from EC2 — nginx now only proxies `/api/*`. Verify the backend still works.
8. Clean up files and docs that are now obsolete:
   - Delete `docker-compose.prod.yml` — every service it defined is now replaced:
     ```
     docker-compose.prod.yml
     ├── postgres   → RDS (replaced in Phase 5)
     ├── backend    → docker run on EC2, image pulled from ECR (replaced in Phase 6)
     └── frontend   → S3 + CloudFront (replaced in Phase 7)
     ```
   - Remove the Node.js install block from `PHASE5_PRODUCTION_DEPLOYMENT.md` (Step 8.1) — the frontend no longer builds on the server
   - Remove Steps 8.2 and 8.3 from `PHASE5_PRODUCTION_DEPLOYMENT.md` — `/var/www/html` is no longer used
   - Update the architecture diagram in `PHASE5_PRODUCTION_DEPLOYMENT.md` to reflect the new layout (CloudFront → S3 for frontend, CloudFront → EC2 for API)

**Validation:** `curl -I https://yourdomain.com/assets/index-abc123.js` returns `Cache-Control: public, max-age=31536000, immutable` and an `X-Cache: Hit from cloudfront` header on the second request.

---

### Phase 8: Observability and Alerting (1–2 weeks)

**Objective:** Know about problems before users report them.

**Tasks:**
1. Configure the Docker container to emit logs to **CloudWatch Logs** using the `awslogs` log driver. Create a log group `/chat-analyzer/backend` with a 30-day retention policy.
2. Create **CloudWatch metric filters** on the log group to turn structured JSON log fields into metrics:
   - Filter on `status_code >= 500` → custom metric `BackendErrors`
   - Filter on `duration_ms` → custom metric `BackendLatency`
3. Create **CloudWatch Alarms** for:
   - `BackendErrors > 1%` of total requests over 5 minutes
   - `BackendLatency p99 > 2000ms` over 5 minutes
   - EC2 `CPUUtilization > 80%` over 10 minutes
   - RDS `FreeStorageSpace < 2 GB`
4. Wire alarms to an **SNS topic** that sends email notifications. Trigger a test alarm manually to confirm the notification reaches you.
5. Add **Sentry** (or equivalent) to the frontend for client-side error reporting. Add the backend Sentry SDK and wire it into the global exception handler from Phase 2.
6. Create a runbook (a short markdown document) for the three most likely incidents: backend container crashed, RDS unreachable, TLS certificate expired. What are the first three commands you run for each?

**Validation:** Intentionally cause a 500 error in production. Confirm the alarm fires within 5 minutes, the notification arrives, and you can find the full stack trace in CloudWatch Logs via the `request_id`.

---

### Phase 9 (Optional): Production Hardening

**Objective:** Replace the remaining manual and fragile pieces with fully managed AWS services. Do this when downtime or data loss would have a real cost — not before.

**Estimated extra cost: ~$60–70/month on top of the existing stack.**

**ALB + ACM (replace nginx + certbot on EC2):**
1. Create an **Application Load Balancer** in the public subnet. Attach a listener on port 443 with an ACM certificate. Forward to a target group containing your EC2 instance on port 8000. What is the benefit of TLS termination at the ALB vs. on the EC2 instance?
2. Update the CloudFront `/api/*` origin to point to the ALB DNS name instead of the EC2 Elastic IP directly.
3. Update the EC2 security group: allow port 8000 inbound **only from the ALB security group** — not from anywhere else. The backend becomes unreachable even if someone knows the EC2 IP.
4. Remove certbot and the HTTPS nginx config from EC2. nginx is no longer needed — the ALB routes directly to the Docker container on port 8000. Uninstall nginx.

**AWS Parameter Store (replace `backend/.env` on disk):**
5. Store all secrets in **AWS Systems Manager Parameter Store** as `SecureString` parameters under the path `/chat-analyzer/prod/`. Why is Parameter Store better than a `.env` file on disk? What is the difference between Parameter Store and Secrets Manager?
6. Grant the EC2 IAM role (`chat-analyzer-ec2-ssm-role`) `ssm:GetParametersByPath` permission for `/chat-analyzer/prod/*`.
7. Update the container startup: read secrets from Parameter Store at launch instead of from a file. Remove `backend/.env` from the server entirely.
8. Update the CI/CD workflow to pull non-secret config from Parameter Store rather than hardcoding it.

**RDS hardening:**
9. Enable **RDS Multi-AZ** on the existing instance. What happens to your application during a Multi-AZ failover? How long does it take?
10. Enable **RDS Proxy** in front of the database. Point `DATABASE_URL` to the proxy endpoint instead of the RDS endpoint directly. What problem does RDS Proxy solve that asyncpg's built-in pool does not?

**Validation:** Terminate the EC2 instance. Launch a replacement from scratch using only the CI/CD workflow and Parameter Store — no manual `.env` creation, no manual cert setup. The application is back within 10 minutes.

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
- [ ] Hashed static assets served with `Cache-Control: public, max-age=31536000, immutable`
- [ ] `index.html` served with `Cache-Control: no-cache` (so deploys are seen immediately)

### Database

- [ ] Automated daily backups enabled with at least 7-day retention
- [ ] A backup restoration has been tested (restored to a test instance and verified data integrity)
- [ ] Deletion protection enabled on the RDS instance
- [ ] Database is not publicly accessible (reachable only from backend security group)
- [ ] All migrations have tested `downgrade()` functions
- [ ] Stale session cleanup verified: expired rows are actually deleted by the scheduled job

### Infrastructure

- [ ] HTTPS enforced; HTTP redirects to HTTPS
- [ ] certbot auto-renewal verified (`sudo certbot renew --dry-run`)
- [ ] Backend port 8000 is NOT reachable directly from the internet (nginx proxies all traffic)
- [ ] EC2 has no SSH inbound rule; access via SSM Session Manager only
- [ ] EC2 has an Elastic IP (IP does not change on restart)
- [ ] DNS TTL is 300 seconds or less
- [ ] Frontend served from S3 + CloudFront, not from the EC2 instance
- [ ] Resource limits (`mem_limit`, `cpus`) set on the backend container

### Security

- [ ] `.env` files are not tracked in git (`git log --all --full-history -- '**/.env'`)
- [ ] HTTP Security Headers present: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- [ ] Dependency scan run: `pip-audit` for backend, `npm audit` for frontend — no high/critical issues
- [ ] CORS `allow_origins` does not include `*`
- [ ] ECR image scanning enabled — no critical CVEs in the deployed image

### CI/CD

- [ ] All tests pass in CI against a real PostgreSQL database (not SQLite)
- [ ] CI blocks merges to `main` when tests fail
- [ ] Deployments are fully automated — no manual steps required
- [ ] Migration runs as a separate CI job before the backend deploy job
- [ ] AWS credentials stored in GitHub Actions Environments — not in repository secrets
- [ ] Each deployment tagged with git SHA; rollback is a one-command operation
- [ ] Post-deployment smoke test (health check) automatically verifies the deployment succeeded
- [ ] Frontend deploy triggers a CloudFront invalidation for `index.html`

### Observability

- [ ] Container logs shipped to CloudWatch Logs with 30-day retention
- [ ] CloudWatch alarms active for: backend error rate, latency, CPU utilization, RDS free storage
- [ ] SNS alarm notifications tested end-to-end (alarm fires → email received)
- [ ] Client-side error reporting active (Sentry or equivalent)
- [ ] RDS slow query log enabled
- [ ] Runbook exists for: backend container crashed, RDS unreachable, certificate expired

---

## 3. Optional Hardening Checklist (Phase 9)

Do these when downtime or data loss would have a real cost.

- [ ] ALB in front of EC2; TLS terminated at ALB with ACM certificate
- [ ] Backend port 8000 accepts traffic only from the ALB security group
- [ ] nginx removed from EC2; ALB routes directly to the Docker container
- [ ] All secrets in AWS Parameter Store — no `.env` files on disk in production
- [ ] RDS Multi-AZ enabled
- [ ] RDS Proxy in front of the database endpoint
