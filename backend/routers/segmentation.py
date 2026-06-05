from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import Folio, get_db
from backend.services.image_fetcher import assign_uploaded_image
from backend.services.segmenter import segment_folio

router = APIRouter(prefix="/folios", tags=["segmentation"])


class SegmentRequest(BaseModel):
    seg_model: str | None = None


@router.post("/{folio_id}/segment")
async def segment(folio_id: int, body: SegmentRequest = None, db: Session = Depends(get_db)):
    folio = db.query(Folio).filter(Folio.id == folio_id).first()
    if not folio:
        raise HTTPException(404, "Folio not found")
    if folio.image_status != "done":
        raise HTTPException(400, "Folio image is not available yet")

    seg_model = body.seg_model if body else None
    try:
        line_ids = await segment_folio(folio, db, seg_model=seg_model)
    except Exception as exc:
        raise HTTPException(500, str(exc))

    return {"folio_id": folio_id, "lines_created": len(line_ids), "line_ids": line_ids}


@router.post("/{folio_id}/upload-image")
async def upload_folio_image(
    folio_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    folio = db.query(Folio).filter(Folio.id == folio_id).first()
    if not folio:
        raise HTTPException(404, "Folio not found")

    content = await file.read()
    assign_uploaded_image(folio, content, file.filename or "image.png", db)
    return {"folio_id": folio_id, "image_status": folio.image_status}
