from fastapi import APIRouter, Depends

from app.dependencies import require_admin
from app.models import User

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/ping")
async def admin_ping(_: User = Depends(require_admin)) -> dict[str, str]:
    return {"message": "admin ok"}
