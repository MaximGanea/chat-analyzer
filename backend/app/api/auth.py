from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models import User
from app.schemas import MessageResponse, TokenResponse, UserCreate, UserLogin, UserRead
from app.services.auth_service import (
    authenticate_user,
    issue_tokens,
    register_user,
    revoke_refresh_token,
    rotate_refresh_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def _set_refresh_cookie(response: Response, token: str) -> None:
    secure = settings.environment.lower() == "production"
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=settings.jwt_refresh_token_days * 24 * 60 * 60,
        path="/api/auth",
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: UserCreate, response: Response, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await register_user(db, payload)
    access_token, refresh_token = await issue_tokens(db, user, user_agent=None, ip_address=None)
    _set_refresh_cookie(response, refresh_token)
    return TokenResponse(access_token=access_token, user=UserRead.model_validate(user))


@router.post("/login", response_model=TokenResponse)
async def login(payload: UserLogin, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await authenticate_user(db, payload.email, payload.password)
    access_token, refresh_token = await issue_tokens(
        db,
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, refresh_token)
    return TokenResponse(access_token=access_token, user=UserRead.model_validate(user))


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    refresh_token: str | None = Cookie(default=None),
) -> TokenResponse:
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token")

    user, access_token, next_refresh_token = await rotate_refresh_token(
        db,
        refresh_token,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, next_refresh_token)
    return TokenResponse(access_token=access_token, user=UserRead.model_validate(user))


@router.post("/logout", response_model=MessageResponse)
async def logout(
    response: Response,
    db: AsyncSession = Depends(get_db),
    refresh_token: str | None = Cookie(default=None),
) -> MessageResponse:
    if refresh_token:
        await revoke_refresh_token(db, refresh_token)

    response.delete_cookie(key="refresh_token", path="/api/auth")
    return MessageResponse(message="Logged out")


@router.get("/me", response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(current_user)
