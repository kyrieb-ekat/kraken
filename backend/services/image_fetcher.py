import asyncio
import shutil
import zipfile
from io import BytesIO
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from backend.database import Folio

IMAGES_DIR = Path(__file__).parent.parent.parent / "data" / "images"


def folio_image_dir(dataset_id: int) -> Path:
    d = IMAGES_DIR / str(dataset_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


async def fetch_folio_image(folio: Folio, db: Session) -> bool:
    """Download a folio's image_url, save to disk, update the DB row. Returns success."""
    if not folio.image_url:
        folio.image_status = "failed"
        db.commit()
        return False

    dest_dir = folio_image_dir(folio.dataset_id)
    # Derive a safe filename from the folio label
    safe_label = folio.folio_label.replace("/", "_").replace(" ", "_")
    dest = dest_dir / f"{safe_label}.png"

    folio.image_status = "downloading"
    db.commit()

    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(folio.image_url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        folio.local_image_path = str(dest)
        folio.image_status = "done"
        db.commit()
        return True
    except Exception:
        folio.image_status = "failed"
        db.commit()
        return False


def assign_uploaded_image(folio: Folio, image_bytes: bytes, filename: str, db: Session):
    dest_dir = folio_image_dir(folio.dataset_id)
    suffix = Path(filename).suffix or ".png"
    safe_label = folio.folio_label.replace("/", "_").replace(" ", "_")
    dest = dest_dir / f"{safe_label}{suffix}"
    dest.write_bytes(image_bytes)
    folio.local_image_path = str(dest)
    folio.image_status = "done"
    db.commit()


def assign_zip_images(dataset_id: int, zip_bytes: bytes, db: Session) -> dict:
    """
    Extract a zip and match files to folios by stem name (case-insensitive).
    Returns {"matched": [...], "unmatched": [...]}
    """
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).all()
    label_map = {f.folio_label.replace("/", "_").replace(" ", "_").lower(): f for f in folios}

    matched = []
    unmatched = []

    with zipfile.ZipFile(BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            p = Path(name)
            if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".tif", ".tiff"}:
                continue
            stem = p.stem.lower()
            folio = label_map.get(stem)
            if folio:
                dest_dir = folio_image_dir(dataset_id)
                dest = dest_dir / f"{p.stem}{p.suffix}"
                dest.write_bytes(zf.read(name))
                folio.local_image_path = str(dest)
                folio.image_status = "done"
                matched.append(name)
            else:
                unmatched.append(name)

    db.commit()
    return {"matched": matched, "unmatched": unmatched}
