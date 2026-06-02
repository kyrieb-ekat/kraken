from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/models", tags=["models"])

MODELS_DIR = Path(__file__).parent.parent.parent / "data" / "models"

# Modern kraken (≥5) outputs .safetensors; older versions used .mlmodel.
# We surface both so either workflow is covered.
_MODEL_SUFFIXES = {".safetensors", ".mlmodel"}


@router.get("")
def list_models():
    models = []
    for p in sorted(
        (p for p in MODELS_DIR.rglob("*") if p.suffix in _MODEL_SUFFIXES),
        key=lambda x: x.stat().st_mtime,
        reverse=True,
    ):
        # Skip checkpoint files that happen to match (e.g. checkpoint_*.ckpt)
        if "checkpoint_" in p.stem:
            continue
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
    if not path.exists() or path.suffix not in _MODEL_SUFFIXES:
        raise HTTPException(404, "Model not found")
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")
