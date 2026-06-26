# chat-analyzer

A full-stack web application for analyzing chat conversations. Currently in active development — the auth layer is complete; chat analysis features are upcoming.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | FastAPI, async SQLAlchemy + asyncpg, Alembic, PyJWT, passlib[argon2] |
| Frontend | React 19, Redux Toolkit, React Router v7, Axios, Vite |
| Database | PostgreSQL 17 |
| Runtime | gunicorn + uvicorn.workers.UvicornWorker |

## Running locally

Create `backend/.env` before starting:

```env
ENVIRONMENT=development
APP_NAME=chat-analyzer
APP_DEBUG=false

DATABASE_URL=postgresql+asyncpg://chat_user:chat_pass@postgres:5432/chat_analyzer

JWT_SECRET_KEY=change-me-in-dev
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

CORS_ALLOWED_ORIGINS=http://localhost:5173
```

Then start the full stack:

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| API docs | http://localhost:8000/docs |

## Running tests

### Backend

First-time setup:

```bash
docker compose up --build -d

docker compose exec postgres psql -U chat_user -d chat_analyzer -c "CREATE DATABASE chat_analyzer_test;"

cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements-test.txt
```

Run:

```bash
cd backend && source venv/bin/activate
pytest           # all tests
pytest -v        # verbose
pytest tests/test_auth.py  # single file
```

### Frontend

```bash
cd frontend && npm install
npm run test:run   # single pass
npm test           # watch mode
```

## Auth architecture

- **Access token** — short-lived JWT (15 min), stored in JS memory only, never in localStorage
- **Refresh token** — long-lived opaque token (7 days), HTTPOnly `SameSite=Lax` cookie, SHA-256 hashed in DB
- **Rotation** — every refresh call revokes the old session and issues a new one
- **Bootstrap** — on page load the app exchanges the refresh cookie for a new access token, restoring the session without a login prompt

## Project structure

```
chat-analyzer/
├── backend/
│   ├── app/
│   │   ├── api/          # route handlers (auth, admin)
│   │   ├── services/     # business logic
│   │   ├── models.py     # ORM models
│   │   ├── schemas.py    # Pydantic schemas
│   │   ├── security.py   # JWT and Argon2 utilities
│   │   └── main.py       # app factory
│   ├── alembic/          # migrations
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── features/     # Redux slices, thunks, feature components
│   │   ├── pages/        # one file per route
│   │   ├── services/     # axios instance, token store
│   │   └── app/          # Redux store
│   └── Dockerfile
├── docs/
├── docker-compose.yml
└── docker-compose.prod.yml
```

## API endpoints

```
POST /api/auth/register   create account
POST /api/auth/login      authenticate and issue tokens
POST /api/auth/refresh    rotate refresh token, issue new access token
POST /api/auth/logout     revoke session
GET  /api/auth/me         current user info

GET  /health              service and database health check
```
