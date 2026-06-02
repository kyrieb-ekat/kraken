import shutil
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from backend.database import Folio, Job, Line

GT_DIR = Path(__file__).parent.parent.parent / "data" / "gt"
COMPILED_DIR = Path(__file__).parent.parent.parent / "data" / "compiled"


def write_gt_files(dataset_id: int, db: Session) -> list[Path]:
    """Write .gt.txt + copied image for every confirmed Line in the dataset.

    Returns the list of image paths written (each has a .gt.txt sibling).
    """
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).all()

    written: list[Path] = []
    for folio in folios:
        lines = (
            db.query(Line)
            .filter(Line.folio_id == folio.id, Line.confirmed == True)
            .order_by(Line.line_index)
            .all()
        )
        for line in lines:
            if not line.transcription or not line.crop_path:
                continue
            crop = Path(line.crop_path)
            if not crop.exists():
                continue

            gt_dir = GT_DIR / str(folio.id)
            gt_dir.mkdir(parents=True, exist_ok=True)

            gt_img = gt_dir / crop.name
            gt_txt = gt_dir / (crop.stem + ".gt.txt")

            if not gt_img.exists():
                shutil.copy2(crop, gt_img)

            gt_txt.write_text(line.transcription, encoding="utf-8")
            written.append(gt_img)

    return written


def compile_dataset(dataset_id: int, db: Session) -> Job:
    """Write GT files and record a manifest of image paths for training.

    No ketos subprocess is needed here — modern kraken accepts image files
    directly via `ketos train -f path`, which discovers .gt.txt siblings
    automatically.  The manifest file (dataset_<id>.txt) is what the trainer
    reads when a training run is started.
    """
    img_files = write_gt_files(dataset_id, db)
    if not img_files:
        raise ValueError("No confirmed lines with transcriptions found")

    COMPILED_DIR.mkdir(parents=True, exist_ok=True)

    # Write a plain manifest so the trainer knows which images to use
    manifest = COMPILED_DIR / f"dataset_{dataset_id}.txt"
    manifest.write_text("\n".join(str(p) for p in img_files), encoding="utf-8")

    job = Job(
        type="compile",
        status="done",
        dataset_id=dataset_id,
        started_at=datetime.utcnow(),
        finished_at=datetime.utcnow(),
        model_path=str(manifest),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    log_path = COMPILED_DIR / f"compile_{job.id}.log"
    log_path.write_text(
        f"Ground truth prepared: {len(img_files)} confirmed lines\n"
        f"Manifest: {manifest}\n\n"
        + "\n".join(str(p) for p in img_files),
        encoding="utf-8",
    )
    job.log_path = str(log_path)
    db.commit()

    return job
