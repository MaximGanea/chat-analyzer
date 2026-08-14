# Architecture

**Project:** temple-project  
**Stack:** FastAPI · React 19 · PostgreSQL 17 · Docker Compose  
**Last reviewed:** 2026-06-08

---

## 1. Current Architecture

### 1.1 Directory Structure

```
temple-project/
├── backend/               # FastAPI application
│   ├── app/
│   │   ├── main.py        # FastAPI app factory, CORS, router registration
│   │   ├── config.py      # pydantic-settings, environment-driven
│   │   ├── database.py    # async SQLAlchemy engine + session factory
│   │   ├── models.py      # User, RefreshSession ORM models
│   │   ├── schemas.py     # Pydantic request/response schemas
│   │   ├── security.py    # Argon2, JWT, refresh token primitives
│   │   ├── dependencies.py# FastAPI Depends: current user, require_admin
│   │   ├── api/
│   │   │   ├── auth.py    # /api/auth/* routes
│   │   │   └── admin.py   # /api/admin/* routes
│   │   └── services/
│   │       └── auth_service.py  # register, login, token rotation, revocation
│   └── alembic/           # Database migrations
├── frontend/              # React 19 + Vite SPA
│   ├── src/
│   │   ├── app/store.js   # Redux store
│   │   ├── features/auth/ # authSlice (Redux Toolkit)
│   │   ├── services/
│   │   │   ├── api.js     # Axios instance + interceptors
│   │   │   └── tokenService.js  # In-memory access token
│   │   ├── components/    # ProtectedRoute, AdminRoute
│   │   └── pages/         # Login, Register, Dashboard, Admin
│   └── Dockerfile         # dev stage only (Vite HMR); prod build runs in CI → S3
├── docker-compose.yml     # Development compose (BACKEND_TARGET=gunicorn for prod-like local)
└── docker-compose.yml     # Local development only
```

### 1.2 Authentication Model

Dual-token pattern. A short-lived JWT access token (15 min) is stored in JavaScript memory. A long-lived opaque refresh token (7 days) is stored as an HTTPOnly `SameSite=Lax` cookie, hashed with SHA-256 before being written to the database. On every refresh, the old session row is revoked and a new one is created (token rotation).

### 1.3 Data Model

Two tables — `users` and `refresh_sessions`. `refresh_sessions` links to `users` with `ON DELETE CASCADE` and stores `token_hash`, `user_agent`, `ip_address`, `expires_at`, and `revoked_at`. The schema supports multi-device sessions and a full audit trail of issued tokens.

### 1.4 Strengths

- **Argon2 password hashing** (`passlib[argon2]`) — current OWASP-recommended algorithm, stronger than bcrypt.
- **Opaque refresh tokens stored as hashes** — even if the `refresh_sessions` table is dumped, raw tokens are not exposed.
- **HTTPOnly + Secure cookie for refresh token** — `_set_refresh_cookie` in `backend/app/api/auth.py:22` sets `secure=True` only when `ENVIRONMENT=production`, blocking JavaScript access (XSS protection).
- **Access token in memory, not localStorage** — `frontend/src/services/tokenService.js` stores the token in a module-level variable. Inaccessible to injected scripts, cleared on tab close.
- **Token refresh deduplication** — `frontend/src/services/api.js:12` uses a `refreshPromise` singleton to prevent multiple concurrent refresh calls when several 401 responses arrive simultaneously.
- **Async throughout** — `SQLAlchemy[asyncio]` + `asyncpg` means the backend never blocks the event loop on database I/O.
- **`pool_pre_ping=True`** — `database.py:12` detects stale connections and replaces them, preventing cryptic errors after the database restarts.
- **Alembic with async support** — `alembic/env.py` correctly uses `async_engine_from_config` with `NullPool` for the migration context.
- **Multi-stage Docker builds** — separate `dev` and `prod` targets, both using gunicorn.

---

## 2. Target Architecture

### 2.1 Design Philosophy

The goal is a deployment that is: **secure by default**, **observable**, **incrementally scalable**, and **operable without heroics**. Two phases — a lean single-server setup that can ship quickly, and a cloud-native setup that can grow.

### 2.2 Phase 1: Pragmatic Production (Single EC2 + RDS)

```
┌─────────────────────────────────────────────────────────┐
│                       Internet                          │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS :443
                         ▼
┌────────────────────────────────────────────────────────┐
│                 Route 53 (DNS)                         │
│           yourdomain.com → EC2 Elastic IP              │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│             EC2 t3.small (Ubuntu 24.04)                │
│                                                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │           nginx (host, port 443/80)             │  │
│  │  • TLS termination via Let's Encrypt (certbot)  │  │
│  │  • Serves static React build from /var/www/html │  │
│  │  • Proxies /api/* to backend:8000               │  │
│  └───────────────────┬─────────────────────────────┘  │
│                      │ localhost:8000                  │
│  ┌───────────────────▼─────────────────────────────┐  │
│  │    Docker: FastAPI (gunicorn + uvicorn)          │  │
│  │    • 2-4 workers                                │  │
│  │    • Reads secrets from env (injected at start) │  │
│  └───────────────────┬─────────────────────────────┘  │
└──────────────────────┼─────────────────────────────────┘
                       │ SSL/TLS (VPC private subnet)
                       ▼
┌────────────────────────────────────────────────────────┐
│              RDS PostgreSQL 17 (db.t4g.micro)          │
│  • Automated daily backups (7-day retention)           │
│  • Single-AZ for now, Multi-AZ when needed             │
│  • Not publicly accessible                             │
└────────────────────────────────────────────────────────┘
```

| Component | Responsibility | Why |
|-----------|----------------|-----|
| Route 53 | DNS, health-check routing | Authoritative DNS with failover capability |
| EC2 t3.small | Compute | Single server, simple operations |
| nginx (host) | TLS termination, static files, reverse proxy | Keeps TLS out of the application layer |
| FastAPI (Docker) | Business logic, API | Containerized for deployment consistency |
| RDS PostgreSQL | Persistent storage | Managed backups, failover, upgrades |

**Why RDS instead of containerized PostgreSQL?**  
A Docker-managed PostgreSQL means you are responsible for backups, failover, storage scaling, and upgrades. RDS handles all of this. The cost difference at small scale (db.t4g.micro ~$12/month) is trivial compared to the operational burden.

**Why nginx on the host instead of in a container?**  
In this single-server setup, nginx manages TLS via `certbot`. Running certbot alongside a containerized nginx requires volume mounts and certificate renewal hooks that add complexity. On the host, `certbot renew` + `systemctl reload nginx` is a cron job.

### 2.3 Phase 2: Cloud-Native (ECS + CloudFront)

```
┌─────────────────────────────────────────────────────────────┐
│                          Internet                           │
└──────────────┬──────────────────────────┬───────────────────┘
               │ (static assets)          │ (API requests)
               ▼                          ▼
┌──────────────────────┐    ┌─────────────────────────────────┐
│   CloudFront + S3    │    │   Application Load Balancer      │
│   (React SPA)        │    │   (HTTPS, WAF, rate limiting)   │
└──────────────────────┘    └──────────────┬──────────────────┘
                                           │
                                           ▼
                            ┌─────────────────────────────────┐
                            │    ECS Fargate (backend)        │
                            │    • Auto-scaling (1–10 tasks)  │
                            │    • Task CPU: 512, Mem: 1024   │
                            │    • Secrets from Secrets Mgr   │
                            └──────────────┬──────────────────┘
                                           │
                              ┌────────────┴───────────┐
                              │                        │
                              ▼                        ▼
               ┌──────────────────────┐  ┌────────────────────────┐
               │  RDS PostgreSQL      │  │  ElastiCache Redis     │
               │  Multi-AZ            │  │  (rate limiter store,  │
               │  Automated backups   │  │   session cache)       │
               └──────────────────────┘  └────────────────────────┘
```

**Why CloudFront + S3?** React builds are static files. Serving from S3 + CloudFront means the backend never serves HTML/JS/CSS. CloudFront caches at 400+ edge locations. You also get automatic invalidation on deploy.

**Why ECS Fargate over EC2 + Docker Compose?** Fargate removes the need to manage EC2 instances. You get rolling deployments, service auto-scaling, and ALB integration natively.

**Why ElastiCache Redis?** The rate limiter needs shared state across multiple backend replicas. Without Redis, each replica has its own counter and you get 1/N of the limiting you expect.

### 2.4 Networking Model

**Phase 1 (EC2):**
- EC2 in public subnet (needs internet access for certbot, npm, apt)
- RDS in private subnet (no public access)
- Security group on RDS: inbound port 5432 from EC2 security group only
- Security group on EC2: inbound 80/443 from 0.0.0.0/0, inbound 22 from your IP only

**Phase 2 (ECS):**
- ALB in public subnets (two AZs minimum)
- ECS tasks in private subnets
- RDS in isolated subnets (no route to internet)
- All inter-service traffic stays within the VPC
- NAT Gateway for tasks that need outbound internet
