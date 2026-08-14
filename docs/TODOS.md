# Action Items & Readiness Checklist

**Last reviewed:** 2026-08-14

---

## 1. Learning Path

### Phase 1: Fix What's Broken ✅ DONE

**Tasks:**
- ✅ `min_length=8`, `max_length=128` on `UserCreate.password` in `schemas.py`
- ✅ `HEALTHCHECK` in `backend/Dockerfile` prod stage

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

**Validation:** You can grep a `request_id` from a client error report and find the corresponding server-side log line within seconds.

---

### Phase 3: Security Hardening (1–2 weeks)

**Objective:** Close the security gaps that expose the application to automated attacks.

**Tasks:**
- ✅ Rate limiting with `slowapi` — `POST /api/auth/login` 10/min, `POST /api/auth/register` 5/min per IP
- ✅ CORS tightened — `allow_methods` and `allow_headers` locked to explicit lists
- Add a per-user session limit to `issue_tokens` in `auth_service.py`: if a user has more than 5 active sessions, revoke the oldest before creating a new one.
- Add the stale session cleanup query as a scheduled task (FastAPI startup event or separate management command).

**Validation:** Run `ab -n 100 -c 10 -p login.json -T application/json http://localhost:8000/api/auth/login`. Confirm responses start returning 429 after the rate limit is hit.

---

### Phase 4: Testing ✅ DONE

**Objective:** Write tests that give you confidence to deploy without manual verification.

**Tasks:**
1. ✅ Set up `pytest` + `pytest-asyncio` + `httpx` in the backend. Write a `conftest.py` that creates a fresh PostgreSQL test schema and tears it down after each test. Not SQLite — use PostgreSQL.
2. ✅ Write `test_auth.py` covering: register → login → refresh → logout → verify token invalidated.
3. ✅ Write `test_token_rotation.py` covering: revoked token reuse rejected, expired token rejected, concurrent refresh produces exactly one valid session.
4. ✅ Set up `vitest` in the frontend. Write tests for `authSlice.js` using a mock API.
5. ✅ Write component tests for `ProtectedRoute` and `AdminRoute` with `@testing-library/react`.

**Validation:** Comment out `session.revoked_at = datetime.now(UTC)` in `auth_service.py:87`. Confirm the token rotation test catches it immediately.

---

### Phase 5: First Production Deployment ✅ DONE

The original build guide has been replaced by `guide/PRODUCTION_RESTORE.md`, which documents the current teardown state and how to rebuild EC2 + RDS from scratch.

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
1. Create an **ECR (Elastic Container Registry)** repository named `temple-project-backend`. Push the backend Docker image to it from your local machine manually first to understand the flow. Why use ECR over Docker Hub for private AWS deployments?
2. Create the GitHub Actions CI workflow. Run on every PR: install deps, run backend tests against a real PostgreSQL service container, run frontend tests.
3. Create the **CD workflow**: on merge to `main` — build the Docker image, push to ECR, connect to EC2 via `aws ssm start-session` and pull + restart the container. Store the AWS credentials in GitHub Actions Environments (not repository secrets — what is the difference?).
4. Add the `migrate` job before `deploy-backend`. What happens if you deploy new code before running migrations?
5. Implement a smoke test in the deploy workflow: `curl` the health endpoint after deployment and verify it returns `{"status": "ok"}`. Fail the workflow if it does not.
6. Tag each deployment with the git SHA: `docker build -t temple-project-backend:${{ github.sha }}`. How does this enable one-command rollback?

**Validation:** Make a code change, push to a feature branch, open a PR, watch CI pass, merge, watch the deployment push the change to production — all without a manual command.

---

### Phase 7: Frontend to S3 + CloudFront ✅ DONE

See `guide/S3_CLOUDFRONT_FRONTEND.md` for the full step-by-step guide.

**Result:** the React build is served from a private S3 bucket through CloudFront. nginx on EC2 only proxies `/api/*`. The frontend is built on the GitHub runner, never on the server.

```
Internet → Route 53 (alias) → CloudFront
                               ├── /*       → S3 (private, OAC)
                               └── /api/*   → origin.temple-project.net → EC2 nginx :80 → :8000
```

**Tasks:**
1. ✅ Private S3 bucket `temple-project-frontend`, all public access blocked. No static website hosting — CloudFront reads the REST API directly via Origin Access Control.
2. ✅ ACM certificate for `temple-project.net` + `www` in `us-east-1`, DNS-validated through Route 53. Auto-renews.
3. ✅ CloudFront distribution: S3 default behavior (`CachingOptimized`), `/api/*` behavior to EC2 (`CachingDisabled`, `AllViewer`, all HTTP methods). WAF enabled.
4. ✅ Route 53 alias records for the apex and `www` point at the distribution. A separate `origin.temple-project.net` A record holds the Elastic IP — CloudFront rejects raw IPs as origins.
5. ✅ `Cache-Control` set per file type by two `aws s3 sync` passes: hashed assets `public, max-age=31536000, immutable`, `index.html` `no-cache`.
6. ✅ `deploy-frontend` in `cd.yml` rebuilt: builds on the runner, syncs to S3, invalidates `/index.html`. Auth is OIDC via `AWS_ROLE_ARN` — the S3 and CloudFront permissions went on `github-actions-temple-project-role`, not on an IAM user.
7. ✅ nginx reduced to the `/api/` proxy. certbot, `/etc/letsencrypt`, `/var/www/html` and Node.js removed from EC2.
8. ✅ `docker-compose.prod.yml` deleted (commit `419245c`) — every service it defined is now RDS, ECR or S3.

**SPA routing note:** direct navigation to `/dashboard` is handled by a CloudFront Function (`spa-router`) on the default behavior, which rewrites extensionless paths to `/index.html`. The older recipe — custom error responses mapping 403/404 to `/index.html` — was rejected deliberately: those apply distribution-wide and would rewrite the backend's own 403/404 responses on `/api/*` into HTML with status 200.

**Deferred:** Step 13 of the guide — locking the EC2 origin to CloudFront with a shared `X-Origin-Verify` header, or an EC2 security group restricted to the `com.amazonaws.global.cloudfront.origin-facing` prefix list. Until then `origin.temple-project.net` and the raw Elastic IP reach the backend directly, bypassing CloudFront and WAF.

**Validation:** ✅ `curl -I https://temple-project.net/assets/index-*.js` returns `Cache-Control: public, max-age=31536000, immutable` and `X-Cache: Hit from cloudfront` on the second request.

---


### Phase 8: Observability and Alerting (1–2 weeks)

**Objective:** Know about problems before users report them.

**Tasks:**
1. Configure the Docker container to emit logs to **CloudWatch Logs** using the `awslogs` log driver. Create a log group `/temple-project/backend` with a 30-day retention policy.
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

**ALB + ACM (replace the remaining nginx on EC2):**

certbot is already gone — CloudFront terminates TLS with an ACM certificate since Phase 7. What is left on EC2 is a plain HTTP nginx proxying `/api/` to the container.

1. Create an **Application Load Balancer** in the public subnet. Attach a listener on port 443 with an ACM certificate. Forward to a target group containing your EC2 instance on port 8000. What is the benefit of TLS termination at the ALB vs. on the EC2 instance?
2. Update the CloudFront `/api/*` origin to point to the ALB DNS name instead of the EC2 Elastic IP directly.
3. Update the EC2 security group: allow port 8000 inbound **only from the ALB security group** — not from anywhere else. The backend becomes unreachable even if someone knows the EC2 IP.
4. Uninstall nginx from EC2 — the ALB routes directly to the Docker container on port 8000, so the last reason to keep it disappears. This also supersedes Step 13 of `guide/S3_CLOUDFRONT_FRONTEND.md`: with the backend reachable only from the ALB security group, the `X-Origin-Verify` header becomes unnecessary.

**AWS Parameter Store (replace `backend/.env` on disk):**
5. Store all secrets in **AWS Systems Manager Parameter Store** as `SecureString` parameters under the path `/temple-project/prod/`. Why is Parameter Store better than a `.env` file on disk? What is the difference between Parameter Store and Secrets Manager?
6. Grant the EC2 IAM role (`temple-project-ec2-ssm-role`) `ssm:GetParametersByPath` permission for `/temple-project/prod/*`.
7. Update the container startup: read secrets from Parameter Store at launch instead of from a file. Remove `backend/.env` from the server entirely.
8. Update the CI/CD workflow to pull non-secret config from Parameter Store rather than hardcoding it.

**RDS hardening:**
9. Enable **RDS Multi-AZ** on the existing instance. What happens to your application during a Multi-AZ failover? How long does it take?
10. Enable **RDS Proxy** in front of the database. Point `DATABASE_URL` to the proxy endpoint instead of the RDS endpoint directly. What problem does RDS Proxy solve that asyncpg's built-in pool does not?
11. Fix RDS certificate verification in `database.py`. Currently the connection is encrypted but skips CA verification (`CERT_NONE`) because the AWS RDS CA is not in the container's trust store. The proper fix: download the AWS RDS CA bundle (`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`), add it to the Docker image via `COPY`, and pass it to the SSL context via `ctx.load_verify_locations()`. Set `ctx.verify_mode = ssl.CERT_REQUIRED` and `ctx.check_hostname = True` after loading the bundle. This is low priority — the VPC already prevents network interception — but worth doing for defence in depth.

**Validation:** Terminate the EC2 instance. Launch a replacement from scratch using only the CI/CD workflow and Parameter Store — no manual `.env` creation, no manual cert setup. The application is back within 10 minutes.

---