# Action Items & Readiness Checklist

**Last reviewed:** 2026-06-15

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

See `guide/EC2_DEPLOYMENT.md` for the full step-by-step guide.

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
6. Update the CI/CD deploy workflow:
   - **IAM first:** add S3 and CloudFront permissions to the `github-actions-chat-analyzer-policy` in IAM (the user created in Phase 6 has no S3 or CloudFront permissions yet — the sync will be denied without this).
   - **Replace** the `deploy-frontend` job in `cd.yml` — the current job builds on EC2 via SSM/git pull; remove that job entirely and add a new job that builds in the GitHub Actions runner and syncs to S3. EC2 itself stays — the backend container keeps running there; only the frontend deploy mechanism changes.
   - Run two separate `aws s3 sync` passes to set the correct `Cache-Control` per file type (task 5 is implemented here):
     - Hashed assets first: `aws s3 sync dist/ s3://chat-analyzer-frontend --delete --exclude "index.html" --cache-control "public, max-age=31536000, immutable"`
     - Then `index.html`: `aws s3 sync dist/ s3://chat-analyzer-frontend --exclude "*" --include "index.html" --cache-control "no-cache"`
   - After the sync, invalidate the CloudFront cache for `index.html` so users see the new version immediately: `aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/index.html"`
7. Remove the nginx static file serving config from EC2 — nginx now only proxies `/api/*`. Verify the backend still works.
   - Also remove certbot from EC2: delete the renewal cron job (`/etc/cron.d/certbot`), the certbot virtualenv (`/opt/certbot`), and the Let's Encrypt certificates (`/etc/letsencrypt`). CloudFront handles TLS via ACM — certbot is dead weight after this phase.
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
11. Fix RDS certificate verification in `database.py`. Currently the connection is encrypted but skips CA verification (`CERT_NONE`) because the AWS RDS CA is not in the container's trust store. The proper fix: download the AWS RDS CA bundle (`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`), add it to the Docker image via `COPY`, and pass it to the SSL context via `ctx.load_verify_locations()`. Set `ctx.verify_mode = ssl.CERT_REQUIRED` and `ctx.check_hostname = True` after loading the bundle. This is low priority — the VPC already prevents network interception — but worth doing for defence in depth.

**Validation:** Terminate the EC2 instance. Launch a replacement from scratch using only the CI/CD workflow and Parameter Store — no manual `.env` creation, no manual cert setup. The application is back within 10 minutes.

---