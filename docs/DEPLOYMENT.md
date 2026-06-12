# Deployment Guide

**Last reviewed:** 2026-06-08

---

## 1. Environment Separation

| Environment | Purpose | Infrastructure |
|-------------|---------|----------------|
| `development` | Local dev (uvicorn --reload) | `docker-compose.yml` |
| `gunicorn` | Local prod-like testing | `BACKEND_TARGET=gunicorn docker compose up` |
| `staging` | Pre-production validation | Identical to prod, smaller instance sizes |
| `production` | Live traffic | Full architecture per [ARCHITECTURE.md](ARCHITECTURE.md) |

Never share databases or secrets across environments. The staging database should be a sanitized snapshot of production (real data shapes, fake PII).

---

## 2. Container Strategy

### Backend targets

| Target | When to use | Process manager |
|--------|-------------|-----------------|
| `dev` | Local development | gunicorn + uvicorn worker, `--reload`, 1 worker |
| `prod` | Production | gunicorn + uvicorn worker, no reload, 2 workers |

Both targets use gunicorn, so behaviour is consistent between local and production.

**Why gunicorn over uvicorn standalone in production?**  
When a uvicorn worker crashes, gunicorn restarts it automatically. It handles graceful shutdown (`SIGTERM`) and graceful reload (`SIGHUP`) without dropping in-flight requests — uvicorn standalone does not.

### Migration strategy

Remove `alembic upgrade head` from `entrypoint.sh` for production. Instead, run migrations as a separate one-time task before deploying containers:

```bash
# Run once before deploying new containers:
docker run --rm --env-file .env.prod backend:latest alembic upgrade head
# Then start the containers:
docker compose -f docker-compose.prod.yml up -d
```

This guarantees exactly one migration run per deployment, not one per replica.

### Frontend: VITE_API_URL for production builds

For production, `VITE_API_URL` must be empty so Axios uses the same origin as the page and nginx proxies `/api/*` to the backend:

```bash
# frontend/.env.production
VITE_API_URL=
```

Or pass at Docker build time:

```dockerfile
# In frontend/Dockerfile prod build stage:
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build
```

```bash
docker build --build-arg VITE_API_URL=https://yourdomain.com -t frontend:latest .
```

### Backend HEALTHCHECK

Add to `backend/Dockerfile` prod stage:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1
```

---

## 3. EC2 Server Setup (Phase 1)

```bash
# 1. Provision EC2 t3.small with Ubuntu 24.04, Elastic IP assigned.

# 2. Install Docker and nginx:
sudo apt update && sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx

# 3. Configure nginx for HTTP first (required for certbot challenge):
sudo nano /etc/nginx/sites-available/yourdomain.com
# → simple HTTP server block serving static files + proxying /api

# 4. Obtain TLS certificate:
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
# certbot automatically modifies the nginx config for HTTPS

# 5. Set up auto-renewal (certbot installs a systemd timer, verify it):
sudo systemctl status certbot.timer

# 6. Deploy backend container:
# Copy .env.prod to server (via scp or secret management)
docker compose -f docker-compose.prod.yml up -d backend

# 7. Build and deploy frontend static files:
# Build locally with VITE_API_URL pointing to the production domain
npm run build
# Copy dist/ to EC2:
rsync -avz dist/ ubuntu@your-ec2:/var/www/html/
```

---

## 4. Database Strategy

**Use RDS, not containerized PostgreSQL.**

1. Create RDS PostgreSQL 17 instance in a private subnet.
2. Create a DB subnet group spanning two AZs.
3. Set security group: inbound 5432 from backend security group only.
4. Enable automated backups with 7-day retention.
5. Enable deletion protection.
6. Use a strong generated password; store in AWS Secrets Manager.
7. Run migrations from CI/CD before deploying new backend containers.

**Connection pooling:** Add PgBouncer as a sidecar or use RDS Proxy:

```yaml
# docker-compose.prod.yml addition:
pgbouncer:
  image: pgbouncer/pgbouncer:latest
  environment:
    DATABASE_URL: "host=your-rds-endpoint dbname=chat_analyzer user=chat_user"
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 100
    DEFAULT_POOL_SIZE: 10
```

Backend `DATABASE_URL` then points to PgBouncer, not RDS directly.

**Stale session cleanup:**

```sql
-- Run weekly via pg_cron or a scheduled Lambda:
DELETE FROM refresh_sessions
WHERE expires_at < NOW() - INTERVAL '1 day'
   OR revoked_at IS NOT NULL;
```

---

## 5. Frontend Deployment

**Phase 1:** Build the React app in CI, `rsync` the `dist/` folder to `/var/www/html/` on EC2. nginx serves static files directly — no container needed for the frontend in Phase 1.

**Phase 2:** Build in CI, upload `dist/` to S3 with static website hosting enabled, create a CloudFront distribution pointing to the S3 origin, invalidate the cache on each deploy:

```bash
aws cloudfront create-invalidation --distribution-id $CF_DIST_ID --paths "/*"
```

---

## 6. Domain and Routing

```
yourdomain.com          → nginx static files (Phase 1) or CloudFront (Phase 2)
yourdomain.com/api/*    → nginx proxies to FastAPI backend
```

Using a single domain for both frontend and API eliminates CORS entirely. The browser sees one origin; no preflight requests; cookies work without `withCredentials`.

---

## 7. Rollback

**Phase 1:** Keep the previous Docker image tagged:

```bash
# Tag on deploy:
docker tag backend:latest backend:v1.2.3
# On rollback:
docker compose stop backend
docker tag backend:v1.2.2 backend:latest
docker compose up -d backend
```

**Phase 2 (ECS):** ECS service deployments are rolling. If the new task fails its health check, ECS keeps old tasks running. Force rollback:

```bash
aws ecs update-service --cluster prod --service backend \
  --task-definition backend:PREVIOUS_REVISION
```

**Database rollbacks:** Alembic `downgrade` scripts exist. Ensure every migration has a tested `downgrade()` function. Never run destructive migrations (dropping columns) until the code that reads them has been deployed for at least one release cycle.

---

## 8. CI/CD Pipeline

### 8.1 Branching Strategy

```
main          ← protected, always deployable, CI gate required
  └─ staging  ← auto-deploys to staging on merge to main
dev           ← integration branch
  └─ feature/*, fix/*, chore/*  ← short-lived branches
```

Every feature branch gets a pull request. PRs require CI passing and at least one reviewer approval. No direct commits to `main` or `dev`.

### 8.2 CI Workflow (.github/workflows/ci.yml)

Runs on every PR:

```yaml
name: CI

on:
  pull_request:
    branches: [main, dev]

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: chat_test
          POSTGRES_USER: chat_user
          POSTGRES_PASSWORD: chat_pass
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt pytest pytest-asyncio httpx
        working-directory: backend
      - run: ruff check .
        working-directory: backend
      - run: DATABASE_URL=postgresql+asyncpg://chat_user:chat_pass@localhost:5432/chat_test pytest
        working-directory: backend

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
        working-directory: frontend
      - run: npm run lint
        working-directory: frontend
      - run: npm run build
        working-directory: frontend
        env:
          VITE_API_URL: ""
```

### 8.3 Deploy Workflow (.github/workflows/deploy.yml)

Runs on merge to `main`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations
        run: |
          docker build -t backend:${{ github.sha }} ./backend --target prod
          docker run --rm \
            --env DATABASE_URL=${{ secrets.DATABASE_URL }} \
            backend:${{ github.sha }} \
            alembic upgrade head

  deploy-backend:
    needs: migrate
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Build and push backend image
        run: |
          docker build -t your-registry/backend:${{ github.sha }} ./backend --target prod
          docker push your-registry/backend:${{ github.sha }}
      - name: Deploy to EC2
        run: |
          ssh ubuntu@${{ secrets.EC2_HOST }} \
            "docker pull your-registry/backend:${{ github.sha }} && \
             docker compose -f docker-compose.prod.yml up -d --no-deps backend"

  deploy-frontend:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
        working-directory: frontend
        env:
          VITE_API_URL: ""
      - name: Upload to S3
        run: aws s3 sync frontend/dist/ s3://your-frontend-bucket/ --delete
      - name: Invalidate CloudFront
        run: aws cloudfront create-invalidation --distribution-id ${{ secrets.CF_DIST_ID }} --paths "/*"
```

### 8.4 Secrets in CI

Never store secrets in the repository. Use GitHub Actions Environments with environment-level secrets:

- `DATABASE_URL` — full connection string including password
- `JWT_SECRET_KEY` — generated with `openssl rand -hex 32`
- `EC2_HOST` — EC2 IP or hostname
- `EC2_SSH_KEY` — private key for deployment SSH
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — scoped IAM user for S3/CloudFront

On the EC2 server, secrets should be in a `.env.prod` file owned by `root` with mode `0600`.

### 8.5 Release Flow

```
1. Developer opens PR: feature/add-rate-limiting
2. CI runs: lint → type check → unit tests → integration tests → build
3. PR reviewed and approved
4. Merge to dev → auto-deploy to staging
5. QA validates on staging
6. PR from dev → main
7. CI runs again on main
8. Merge to main triggers deploy pipeline:
   a. Run DB migrations (separate job, fail-safe)
   b. Build and push Docker image tagged with git SHA
   c. Deploy backend (rolling restart)
   d. Build frontend with VITE_API_URL=""
   e. Upload to S3, invalidate CloudFront
9. Monitor error rates and latency for 15 minutes post-deploy
10. Automated rollback trigger if error rate > threshold
```
