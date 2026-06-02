from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import Folio, Line, get_db
from backend.services.segmenter import merge_lines, split_line

router = APIRouter(tags=["transcriptions"])

DATA_ROOT = Path(__file__).parent.parent.parent / "data"


# ── Lines for a folio ──────────────────────────────────────────────────────────

@router.get("/folios/{folio_id}/lines")
def get_lines(folio_id: int, db: Session = Depends(get_db)):
    folio = db.query(Folio).filter(Folio.id == folio_id).first()
    if not folio:
        raise HTTPException(404, "Folio not found")

    lines = (
        db.query(Line)
        .filter(Line.folio_id == folio_id)
        .order_by(Line.line_index)
        .all()
    )

    def crop_url(line):
        if not line.crop_path:
            return None
        return "/static/" + Path(line.crop_path).relative_to(DATA_ROOT).as_posix()

    def img_url(folio):
        if not folio.local_image_path:
            return None
        return "/static/" + Path(folio.local_image_path).relative_to(DATA_ROOT).as_posix()

    return {
        "folio_id": folio_id,
        "folio_label": folio.folio_label,
        "page_image_url": img_url(folio),
        "text_pool": folio.get_text_pool(),
        "lines": [
            {
                "id": l.id,
                "line_index": l.line_index,
                "crop_url": crop_url(l),
                "crop_path": l.crop_path,
                "polygon": l.get_polygon(),
                "transcription": l.transcription,
                "confirmed": l.confirmed,
            }
            for l in lines
        ],
    }


@router.get("/folios/{folio_id}/text-pool")
def get_text_pool(folio_id: int, db: Session = Depends(get_db)):
    folio = db.query(Folio).filter(Folio.id == folio_id).first()
    if not folio:
        raise HTTPException(404, "Folio not found")
    return {"folio_id": folio_id, "text_pool": folio.get_text_pool()}


# ── Line CRUD ─────────────────────────────────────────────────────────────────

class LineUpdate(BaseModel):
    transcription: str | None = None
    confirmed: bool | None = None
    line_index: int | None = None
    polygon: list | None = None


@router.patch("/lines/{line_id}")
def update_line(line_id: int, body: LineUpdate, db: Session = Depends(get_db)):
    line = db.query(Line).filter(Line.id == line_id).first()
    if not line:
        raise HTTPException(404, "Line not found")
    if body.transcription is not None:
        line.transcription = body.transcription
    if body.confirmed is not None:
        line.confirmed = body.confirmed
    if body.line_index is not None:
        line.line_index = body.line_index
    if body.polygon is not None:
        line.set_polygon(body.polygon)
    db.commit()
    return {"id": line.id, "transcription": line.transcription, "confirmed": line.confirmed, "line_index": line.line_index}


@router.delete("/lines/{line_id}")
def delete_line(line_id: int, db: Session = Depends(get_db)):
    line = db.query(Line).filter(Line.id == line_id).first()
    if not line:
        raise HTTPException(404, "Line not found")
    db.delete(line)
    db.commit()
    return {"deleted": line_id}


class SplitBody(BaseModel):
    x_ratio: float  # 0.0 – 1.0


@router.post("/lines/{line_id}/split")
def split(line_id: int, body: SplitBody, db: Session = Depends(get_db)):
    line = db.query(Line).filter(Line.id == line_id).first()
    if not line:
        raise HTTPException(404, "Line not found")
    if not (0.0 < body.x_ratio < 1.0):
        raise HTTPException(400, "x_ratio must be between 0 and 1 exclusive")

    folio = db.query(Folio).filter(Folio.id == line.folio_id).first()
    if not folio or not folio.local_image_path:
        raise HTTPException(400, "Folio image not available")

    line_a, line_b = split_line(line, body.x_ratio, folio.local_image_path, db)
    return {
        "line_a": {"id": line_a.id, "line_index": line_a.line_index},
        "line_b": {"id": line_b.id, "line_index": line_b.line_index},
    }


class MergeBody(BaseModel):
    line_ids: list[int]


@router.post("/lines/merge")
def merge(body: MergeBody, db: Session = Depends(get_db)):
    if len(body.line_ids) != 2:
        raise HTTPException(400, "Exactly two line IDs required")

    lines = db.query(Line).filter(Line.id.in_(body.line_ids)).all()
    if len(lines) != 2:
        raise HTTPException(404, "One or both lines not found")
    if lines[0].folio_id != lines[1].folio_id:
        raise HTTPException(400, "Lines must belong to the same folio")

    folio = db.query(Folio).filter(Folio.id == lines[0].folio_id).first()
    if not folio or not folio.local_image_path:
        raise HTTPException(400, "Folio image not available")

    merged = merge_lines(lines[0], lines[1], folio.local_image_path, db)
    return {"id": merged.id, "line_index": merged.line_index, "transcription": merged.transcription}


class AddLineBody(BaseModel):
    polygon: list[list[int]] | None = None  # [[x,y], ...] preferred
    bbox: list[int] | None = None           # [x0, y0, x1, y1] fallback
    transcription: str | None = None


@router.post("/folios/{folio_id}/lines")
def add_line(folio_id: int, body: AddLineBody, db: Session = Depends(get_db)):
    folio = db.query(Folio).filter(Folio.id == folio_id).first()
    if not folio:
        raise HTTPException(404, "Folio not found")
    if not folio.local_image_path:
        raise HTTPException(400, "Folio image not available")

    from PIL import Image as PILImage
    from backend.services.segmenter import folio_lines_dir

    # Resolve geometry: polygon takes precedence over bbox
    if body.polygon and len(body.polygon) >= 3:
        pts = body.polygon
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        stored_polygon = pts
    elif body.bbox and len(body.bbox) == 4:
        x0, y0, x1, y1 = body.bbox
        stored_polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    else:
        raise HTTPException(400, "polygon (≥ 3 points) or bbox ([x0,y0,x1,y1]) required")

    page_img = PILImage.open(folio.local_image_path).convert("RGB")
    w, h = page_img.size
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    if x1 <= x0 or y1 <= y0:
        raise HTTPException(400, "Geometry has zero or negative size after clamping to image bounds")

    max_idx = db.query(Line).filter(Line.folio_id == folio_id).count()
    lines_dir = folio_lines_dir(folio_id)
    crop = page_img.crop((x0, y0, x1, y1))
    crop_path = lines_dir / f"line_{max_idx:04d}_manual.png"
    crop.save(crop_path)

    line = Line(
        folio_id=folio_id,
        line_index=max_idx,
        crop_path=str(crop_path),
        transcription=body.transcription,
        confirmed=False,
    )
    line.set_polygon(stored_polygon)
    db.add(line)
    db.commit()
    db.refresh(line)

    crop_url = "/static/" + crop_path.relative_to(DATA_ROOT).as_posix()
    return {
        "id": line.id,
        "line_index": line.line_index,
        "crop_url": crop_url,
        "polygon": line.get_polygon(),
    }


# ── Restore (used by undo) ─────────────────────────────────────────────────────

class RestoreLineBody(BaseModel):
    folio_id: int
    line_index: int
    crop_path: str | None = None
    polygon: list = []
    transcription: str | None = None
    confirmed: bool = False


@router.post("/lines/restore")
def restore_line(body: RestoreLineBody, db: Session = Depends(get_db)):
    """Re-insert a previously deleted Line DB row (crop file remains on disk)."""
    line = Line(
        folio_id=body.folio_id,
        line_index=body.line_index,
        crop_path=body.crop_path,
        transcription=body.transcription,
        confirmed=body.confirmed,
    )
    line.set_polygon(body.polygon)
    db.add(line)
    db.commit()
    db.refresh(line)

    crop_url = None
    if body.crop_path:
        try:
            crop_url = "/static/" + Path(body.crop_path).relative_to(DATA_ROOT).as_posix()
        except ValueError:
            pass

    return {
        "id": line.id,
        "line_index": line.line_index,
        "crop_url": crop_url,
        "crop_path": line.crop_path,
        "polygon": line.get_polygon(),
        "transcription": line.transcription,
        "confirmed": line.confirmed,
    }
