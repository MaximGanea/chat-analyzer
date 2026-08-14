import os
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.database import get_db
from app.limiter import limiter
from app.main import app
from app.models import Base

# Disable rate limiting for all tests so register/login calls don't
# trip the per-minute limits.
limiter._enabled = False

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://temple_user:temple_pass@localhost:5432/temple_project_test",
)
# psycopg (v3 sync) is already in requirements.txt — use it for schema management
# so we avoid any async event-loop concerns at the session level.
_SYNC_URL = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql+psycopg://")


@pytest.fixture(scope="session", autouse=True)
def _schema():
    """Drop and recreate all tables once per test session (sync, no event loop)."""
    engine = create_engine(_SYNC_URL, poolclass=NullPool)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
async def db_session(_schema):
    """
    Function-scoped async session.  Each test gets its own asyncpg connection
    (NullPool — no cross-test connection reuse) wrapped in a transaction that
    rolls back on teardown, so no test data leaks between tests.
    """
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    async with engine.connect() as conn:
        await conn.begin()
        session = AsyncSession(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
        yield session
        await session.close()
        await conn.rollback()
    await engine.dispose()


@pytest.fixture
async def client(db_session):
    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
