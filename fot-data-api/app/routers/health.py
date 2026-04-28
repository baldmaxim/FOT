from fastapi import APIRouter

router = APIRouter()


@router.get("/external/v1/health", summary="Health check (без аутентификации)")
async def health() -> dict[str, bool]:
    return {"ok": True}
