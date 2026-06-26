import pytest
from httpx import AsyncClient


EMAIL = "happy@example.com"
PASSWORD = "securepass1"


async def test_register_login_refresh_logout(client: AsyncClient) -> None:
    # --- register ---
    res = await client.post("/api/auth/register", json={"email": EMAIL, "password": PASSWORD})
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["email"] == EMAIL
    access_token = body["access_token"]
    assert "refresh_token" in res.cookies

    # --- /me with the access token ---
    res = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert res.status_code == 200
    assert res.json()["email"] == EMAIL

    # --- refresh ---
    # The register response set the refresh_token cookie (path=/api/auth).
    # httpx sends it automatically for /api/auth/refresh.
    res = await client.post("/api/auth/refresh")
    assert res.status_code == 200
    new_access = res.json()["access_token"]

    res = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_access}"})
    assert res.status_code == 200

    # --- logout ---
    res = await client.post("/api/auth/logout")
    assert res.status_code == 200

    # --- refresh after logout must fail: session is revoked ---
    res = await client.post("/api/auth/refresh")
    assert res.status_code == 401
