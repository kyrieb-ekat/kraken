from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter(prefix="/models", tags=["models"])

MODELS_DIR = Path(__file__).parent.parent.parent / "data" / "models"


@router.get("")
def list_models():
    models = []
    for p in sorted(MODELS_DIR.rglob("*.mlmodel"), key=lambda x: x.stat().st_mtime, reverse=True):
        stat = p.stat()
        models.append({
            "name": p.stem,
            "path": str(p),
            "relative_path": str(p.relative_to(MODELS_DIR)),
            "size_mb": round(stat.st_size / 1_048_576, 2),
            "created_at": stat.st_mtime,
        })
    return models


@router.get("/download/{model_name:path}")
def download_model(model_name: str):
    path = MODELS_DIR / model_name
    if not path.exists() or not path.suffix == ".mlmodel":
        from fastapi import HTTPException
        raise HTTPException(404, "Model not found")
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")
