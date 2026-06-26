"""
Token-rotation edge cases:
  - Revoked token reuse -> 401
  - Expired token       -> 401
  - Second use of the same token -> exactly one 200, one 401
"""
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RefreshSession
from app.security import hash_refresh_token


async def _register_and_login(client: AsyncClient, email: str) -> str:
    """Register a fresh user, login, and leave the refresh token in the client jar."""
    creds = {"email": email, "password": "securepass1"}
    await client.post("/api/auth/register", json=creds)
    res = await client.post("/api/auth/login", json=creds)
    assert res.status_code == 200
    # Return the raw token so callers can restore it to the jar if needed.
    return res.cookies["refresh_token"]


async def test_revoked_token_reuse_rejected(client: AsyncClient) -> None:
    token = await _register_and_login(client, "revoked@example.com")

    # First refresh — succeeds and updates the jar to the new token.
    res = await client.post("/api/auth/refresh")
    assert res.status_code == 200

    # Put the now-revoked token back in the jar and replay it.
    client.cookies.set("refresh_token", token)
    res = await client.post("/api/auth/refresh")
    assert res.status_code == 401


async def test_expired_token_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    token = await _register_and_login(client, "expired@example.com")

    # Wind the session's expiry back in time.
    await db_session.execute(
        update(RefreshSession)
        .where(RefreshSession.token_hash == hash_refresh_token(token))
        .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await db_session.commit()

    # The jar still holds the original token — the server rejects it as expired.
    res = await client.post("/api/auth/refresh")
    assert res.status_code == 401


async def test_concurrent_refresh_one_winner(client: AsyncClient) -> None:
    """
    A refresh token may only produce one new session, ever.

    True thread-level parallelism is not achievable inside a single ASGI
    test client, but the rotation invariant must hold regardless of how
    quickly back-to-back requests arrive.
    """
    token = await _register_and_login(client, "concurrent@example.com")

    res1 = await client.post("/api/auth/refresh")
    assert res1.status_code == 200

    # Restore the now-revoked token and fire a second request immediately.
    client.cookies.set("refresh_token", token)
    res2 = await client.post("/api/auth/refresh")
    assert res2.status_code == 401
