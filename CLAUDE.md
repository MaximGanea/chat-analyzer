# CLAUDE.md — temple-project

This file is read automatically by Claude Code at session start.

## Project

Three-tier web app: FastAPI backend + React 19 SPA + PostgreSQL. Current scope: production-ready auth layer. Chat analysis features are not yet built.

**Production topology:** Route 53 → CloudFront → S3 (React build, private bucket via OAC) for `/*`, and → `origin.temple-project.net` → EC2 nginx :80 → backend container :8000 for `/api/*`. PostgreSQL is RDS in a private subnet. Deploys run from `.github/workflows/cd.yml` on push to `master`, authenticating to AWS via OIDC.

**Stack:** FastAPI · async SQLAlchemy + asyncpg · Alembic · pydantic-settings · PyJWT · passlib[argon2] · React 19 · Redux Toolkit · React Router v7 · Axios · Vite · gunicorn + uvicorn.workers.UvicornWorker

## Running locally

```bash
docker compose up --build   # postgres + backend (gunicorn --reload, 1 worker) + frontend (Vite HMR)
```

Backend: `http://localhost:8000` — Frontend: `http://localhost:5173`

## Key files

| What | Where |
|------|-------|
| FastAPI app factory | `backend/app/main.py` |
| Settings / env vars | `backend/app/config.py` |
| DB engine + session | `backend/app/database.py` |
| Auth routes | `backend/app/api/auth.py` |
| Admin routes | `backend/app/api/admin.py` |
| Auth business logic | `backend/app/services/auth_service.py` |
| ORM models | `backend/app/models.py` |
| Pydantic schemas | `backend/app/schemas.py` |
| JWT / Argon2 utils | `backend/app/security.py` |
| Axios instance + interceptors | `frontend/src/services/api.js` |
| In-memory token store | `frontend/src/services/tokenService.js` |
| Redux auth slice + thunks | `frontend/src/features/auth/authSlice.js` |
| Route guards | `frontend/src/features/auth/components/` |
| Dev compose | `docker-compose.yml` |
| CD pipeline | `.github/workflows/cd.yml` |
| Deployment guides | `guide/` |

## Auth architecture

- **Access token** — short-lived JWT (15 min), stored only in `tokenService.js` memory, never in Redux state or localStorage
- **Refresh token** — long-lived opaque token (7 days), HTTPOnly `SameSite=Lax` cookie, SHA-256 hashed in DB
- **Rotation** — every refresh revokes the old session and creates a new one
- **Deduplication** — `api.js` uses a `refreshPromise` singleton to prevent concurrent refresh races
- All routes prefixed `/api` via `include_router(..., prefix="/api")`

## Docker targets

| Target | Workers | Reload | Used by |
|--------|---------|--------|---------|
| `dev` | 1 | yes | `docker-compose.yml` |
| `prod` | 2 | no | `docker run` on EC2, image from ECR (`cd.yml`) |

---

## Backend rules

- All route handlers must be `async def`. Never use `def` for handlers that touch the DB or any I/O.
- Business logic lives in `services/`. Route handlers in `api/` only validate input, call a service, and return a response. No DB queries in route handlers directly.
- All dependencies injected via `Depends()`. Never import session, settings, or current user from global scope inside a handler.
- Use `get_settings()` (the `@lru_cache` function) everywhere. Never instantiate `Settings()` directly.
- Pydantic schemas for every request body and response. Never accept or return raw dicts from route handlers.
- Never log passwords, tokens, or any secret material — not even partially.
- `ENVIRONMENT=production` must be set in prod. The refresh cookie's `secure=True` flag depends on it (`auth.py`).
- New API routes go under `prefix="/api"` — do not change the prefix convention.
- Alembic migrations run as a separate one-off step before deploying, not inside `entrypoint.sh` (race condition with multiple replicas). `entrypoint.sh` only runs them when `RUN_MIGRATIONS=1`, which `docker-compose.yml` sets for local dev; production uses the `migrate` job in `cd.yml`.
- Password fields must enforce `min_length=8`, `max_length=128` at the schema level (`schemas.py`).

## Frontend rules

- **Never store the access token in Redux state.** `tokenService.js` is the single source of truth. The interceptor in `api.js` reads from it. Redux holds only `user`, `isAuthenticated`, `isLoading`, `isBootstrapping`, `error`.
- **Never store tokens in `localStorage` or `sessionStorage`.** Access token = JS memory (`tokenService.js`). Refresh token = HTTPOnly cookie (set by the server, untouchable by JS).
- All API calls go through the `api` axios instance from `services/api.js`. Never import axios directly in a component or slice.
- Thunks use `rejectWithValue` for error handling. Components read `action.payload` on rejection, never catch inside the thunk unless cleanup is needed.
- **Logout must clear local state regardless of whether the API call succeeds.** Handle both `logoutThunk.fulfilled` and `logoutThunk.rejected` in the slice.
- No UI library imports unless the library is used consistently across the whole app. Currently no UI library — use plain HTML elements.
- Password inputs always have `minLength={8}` and `maxLength={128}`.
- `isBootstrapping` must be checked before any auth redirect in route guards. Redirecting before bootstrap completes causes a flash to `/login` on hard refresh.

## Frontend folder conventions

```
src/
├── app/
│   └── store.js                  # store config only, no logic
├── features/
│   └── <feature>/
│       ├── <feature>Slice.js     # slice + thunks + selectors
│       └── components/           # components owned by this feature
├── pages/                        # one file per route, thin — delegate to features
├── services/                     # infrastructure: api instance, tokenService
├── hooks/                        # shared custom hooks (when needed)
└── components/                   # truly shared UI primitives only
```

- Route guards (`ProtectedRoute`, `AdminRoute`) live in `features/auth/components/` — they are auth concerns.
- Selectors are defined and exported from the slice file, not in separate files (until the slice grows large enough to warrant splitting).
- When adding a new feature, create `features/<name>/<name>Slice.js` and co-locate its components under `features/<name>/components/`.
- RTK Query is the preferred pattern for data fetching as new features are built. Manual thunks + axios are acceptable for mutations and auth flows.
