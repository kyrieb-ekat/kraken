import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from backend.database import Dataset, Folio, get_db
from backend.services.csv_parser import parse_cantus_csv
from backend.services.image_fetcher import (
    assign_uploaded_image,
    assign_zip_images,
    fetch_folio_image,
)

router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.post("")
async def upload_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    content = await file.read()
    try:
        folios_data = parse_cantus_csv(content)
    except Exception as exc:
        raise HTTPException(400, f"CSV parse error: {exc}")

    dataset = Dataset(name=file.filename or "dataset")
    db.add(dataset)
    db.commit()
    db.refresh(dataset)

    for label, info in folios_data.items():
        folio = Folio(
            dataset_id=dataset.id,
            folio_label=label,
            image_url=info["image_url"],
            image_status="pending" if info["image_url"] else "failed",
        )
        folio.set_text_pool(info["text_pool"])
        db.add(folio)

    db.commit()
    return {"id": dataset.id, "name": dataset.name, "folio_count": len(folios_data)}


@router.get("")
def list_datasets(db: Session = Depends(get_db)):
    datasets = db.query(Dataset).order_by(Dataset.uploaded_at.desc()).all()
    result = []
    for ds in datasets:
        folios = db.query(Folio).filter(Folio.dataset_id == ds.id).all()
        result.append({
            "id": ds.id,
            "name": ds.name,
            "uploaded_at": ds.uploaded_at.isoformat(),
            "folio_count": len(folios),
            "image_status": {
                s: sum(1 for f in folios if f.image_status == s)
                for s in ("pending", "downloading", "done", "failed")
            },
        })
    return result


@router.get("/{dataset_id}/folios")
def list_folios(dataset_id: int, db: Session = Depends(get_db)):
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).order_by(Folio.folio_label).all()
    return [
        {
            "id": f.id,
            "folio_label": f.folio_label,
            "image_url": f.image_url,
            "image_status": f.image_status,
            "segmented": f.segmented,
            "text_pool_count": len(f.get_text_pool()),
        }
        for f in folios
    ]


@router.post("/{dataset_id}/fetch-images")
async def fetch_images(dataset_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    folios = (
        db.query(Folio)
        .filter(Folio.dataset_id == dataset_id, Folio.image_status.in_(["pending", "failed"]))
        .all()
    )
    if not folios:
        return {"queued": 0}

    async def _run():
        tasks = [fetch_folio_image(f, db) for f in folios]
        await asyncio.gather(*tasks)

    background_tasks.add_task(_run)
    return {"queued": len(folios)}


@router.post("/{dataset_id}/upload-images-zip")
async def upload_images_zip(
    dataset_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    content = await file.read()
    try:
        result = assign_zip_images(dataset_id, content, db)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    return result
